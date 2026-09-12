#!/usr/bin/env python3
# coding: utf-8
"""Render a calm, readable product film from disclosed, isolated App recordings.

The camera is fixed within every shot. Cuts select real recorded UI; text and
controls are never rebuilt. Input/execution clips retain their order, and the
last recorded result can be held longer for reading. No screen, microphone,
workspace, credential store or network is accessed. Requires Pillow and ffmpeg.
"""
import argparse
import bisect
import functools
import glob
import json
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
ROOT = Path(__file__).resolve().parents[1]
BG, FG, MUTED, ACCENT = (18, 20, 23), (245, 244, 240), (174, 180, 187), (175, 211, 199)
FONT = None
LOGO = None
DISCLOSURE = {
    'zh-CN': '使用示例资料，模型回复为演示预设，过程经过剪辑。',
    'en': 'Example data · Scripted AI responses · Edited for presentation',
}

# A continuous learning story becomes research and everyday work. Durations are
# editorial reading time, never claims about model latency. No automatic pan,
# zoom, looped camera or chapter counter is used.
SHOTS = [
    # id, scene, moment, seconds, layout, zh title, zh detail, en title, en detail
    ('ask', 'course-intake', 'input', 6, 'wide', '从一份课件开始。', '把整理资料这一步，交给你的 AI 助手。', 'Start with a handout.', 'Give your AI assistant a clear next step.'),
    ('organize', 'course-intake', 'result', 8, 'wide', '一次对话，留下可继续的成果。', '原件、主笔记与本周任务，归入同一个课程项目。', 'One chat. Work you can build on.', 'The source, one main note and a task, together in a course project.'),
    ('edit', 'read-edit', 'input', 7, 'wide', '再写下自己的理解。', '直接编辑 Markdown，保留你的观察和判断。', 'Make the note your own.', 'Edit the Markdown directly. Keep your observations and judgement.'),
    ('note', 'read-edit', 'result', 6, 'split', '知识可以积累。', '一篇主笔记，继续阅读、编辑与保存。', 'Knowledge you can build on.', 'One main note to keep reading, editing and saving.'),
    ('ask-again', 'knowledge-reuse', 'input', 5, 'wide', '换个对话，接着问。', '不用来回上传刚才的课件。', 'Start a new chat. Keep going.', 'No need to attach the same handout again.'),
    ('answer', 'knowledge-reuse', 'result', 8, 'wide', '回答，接得上已有知识。', '从已保存的项目资料中检索，并给出来源。', 'Answers grounded in your project.', 'Retrieve saved project material, with sources you can inspect.'),
    ('source', 'knowledge-reuse', 'source-citations-expanded', 5, 'wide', '从回答，继续核对来源。', '打开引用，继续阅读笔记与资料。', 'Go back to the source.', 'Open a citation. Keep reading the notes and sources.'),
    ('paper', 'research-library', 'durable-paper-main-note', 5, 'split', '把文献留在\n研究里。', '论文原件与可编辑的研究笔记，共同积累。', 'Give your research a home.', 'Keep papers alongside research notes you can revise.'),
    ('research', 'research-library', 'result', 7, 'wide', '也看见它们之间的关系。', '明确引用、共同标签与项目归属，分别呈现。', 'See how the work connects.', 'Citations, shared tags and project membership stay distinct.'),
    ('reschedule', 'daily-update', 'input', 5, 'wide', '计划变了，补充一句。', '继续对话，更新日常项目里的原有任务。', 'Plans change. Just say so.', 'Continue the conversation to update an existing personal task.'),
    ('task', 'daily-update', 'result', 7, 'wide', '时间变了，清单还在。', '日期、状态和归属，也可以随时手动调整。', 'A new deadline. The same task.', 'Adjust dates, status and project membership by hand, too.'),
    ('progress', 'overview', 'task-progress-overview', 7, 'wide', '看清进展，再决定下一步。', '课程、科研与日常，汇入同一个工作区。', 'See the progress. Choose what’s next.', 'Courses, research and personal work, in one workspace.'),
    ('activity', 'overview', 'result', 6, 'wide', '趋势背后，是具体的任务与资料。', '点开某一天，回到对应的任务和资料。', 'Tasks and sources behind every point.', 'Select a day to return to its tasks and sources.'),
    ('models', 'personal-workspace', 'input', 7, 'split', '模型，由你选择。', '按对话调整模型与推理强度。\n可使用自己的兼容 API。', 'Your model. Your choice.', 'Choose a model and reasoning effort for each chat.\nConnect your own compatible API.'),
    ('privacy', 'personal-workspace', 'result', 8, 'privacy', '知识留在本机，连接由你决定。', '工作区本地保存；模型请求发送给你选择的服务。\n跨设备同步可选用自己的服务器。', 'Local knowledge. Connections you choose.', 'Your workspace is stored locally. Model requests go to your chosen service.\nSelf-hosted sync is optional.'),
]

# Focused excerpts of actual UI, not reshaped controls. Per-language crops come
# from the reviewed scene map. Overrides only narrow an already verified frame.
CROPS = {
    'organize': (540, 280, 800, 330),
    'edit': (825, 565, 590, 170),
    'note': (825, 215, 585, 430),
    'source': (545, 438, 790, 110),
    'paper': (825, 335, 585, 465),
    'research': (255, 265, 1130, 550),
    'progress': (240, 380, 1155, 365),
    'activity': (260, 320, 1110, 570),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def locate_font(explicit=None):
    if explicit:
        return str(explicit)
    paths = glob.glob('/System/Library/AssetsV2/com_apple_MobileAsset_Font*/**/PingFang.ttc', recursive=True)
    return next(iter(paths), '/System/Library/Fonts/Supplemental/Arial Unicode.ttf')


@functools.lru_cache(maxsize=40)
def font(size):
    return ImageFont.truetype(FONT, size, index=0)


def text(im, value, xy, size=30, color=FG):
    ImageDraw.Draw(im).text(xy, value, font=font(size), fill=color)


def wrapped(value, size, width):
    lines = []
    for paragraph in value.split('\n'):
        # English wraps at words; Chinese at characters. Explicit newlines stay.
        word_wrap = not any('\u3400' <= c <= '\u9fff' for c in paragraph)
        units = paragraph.split(' ') if word_wrap else list(paragraph)
        separator = ' ' if word_wrap else ''
        current = ''
        for unit in units:
            candidate = current + (separator if current else '') + unit
            if current and font(size).getlength(candidate) > width:
                lines.append(current)
                current = unit
            else:
                current = candidate
        lines.append(current)
    return lines


def paragraph(im, value, xy, size, width, color=FG, leading=1.38):
    x, y = xy
    for line in wrapped(value, size, width):
        text(im, line, (x, round(y)), size, color)
        y += size * leading
    return y


def fit(value, maximum, width):
    size = maximum
    while size > 24 and font(size).getlength(value) > width:
        size -= 1
    return size


@functools.lru_cache(maxsize=24)
def load_frame(filename):
    with Image.open(filename) as source:
        return source.convert('RGB')


def canvas():
    return Image.new('RGB', (W, H), BG)


def brand(im):
    im.paste(LOGO.resize((42, 42), Image.Resampling.LANCZOS), (72, 40), LOGO.resize((42, 42), Image.Resampling.LANCZOS))
    text(im, 'AI Bro', (130, 40), 31)


def display_crop(im, source, crop, box):
    x, y, w, h = crop
    bx, by, bw, bh = box
    require(w > 0 and h > 0 and x >= 0 and y >= 0 and x+w <= source.width and y+h <= source.height, 'Crop is outside the captured frame')
    scale = min(bw / w, bh / h, 3.15)
    size = (round(w*scale), round(h*scale))
    fragment = source.crop((x, y, x+w, y+h)).resize(size, Image.Resampling.LANCZOS)
    # A quiet, precise edge. No enlarged fake desktop/window wrapper or shadow.
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0]-1, size[1]-1), radius=18, fill=255)
    left, top = round(bx+(bw-size[0])/2), round(by+(bh-size[1])/2)
    im.paste(fragment, (left, top), mask)
    return {'x': left, 'y': top, 'width': size[0], 'height': size[1], 'scale': scale}


class Recording:
    def __init__(self, directory, map_path=None):
        self.directory = directory.resolve()
        self.manifest = json.loads((self.directory/'manifest.json').read_text())
        self.map = json.loads((map_path or self.directory/'scene-map.json').read_text())
        require(not self.manifest.get('error'), 'Cannot render a failed recording')
        require(self.manifest.get('syntheticOnly') is True and self.manifest.get('scriptedResponses') is True, 'Only explicitly disclosed synthetic recordings are accepted')
        require(self.manifest.get('lang') in ('zh-CN', 'en') and self.map.get('lang') == self.manifest['lang'], 'Recording and scene-map languages must match')
        require(self.map.get('schemaVersion') == 1, 'Unsupported scene-map schema')
        self.lang = self.manifest['lang']
        self.en = self.lang == 'en'
        self.frames = self.manifest['frames']
        self.times = [entry['at'] for entry in self.frames]
        require(self.times and self.times == sorted(self.times), 'Frame timestamps must be ordered')
        self.size = (self.map['coordinateSpace']['width'], self.map['coordinateSpace']['height'])
        require(self.size == (self.manifest['width'], self.manifest['height']), 'Scene-map coordinates do not match capture pixels')
        self.scenes = {s['id']: s for s in self.map['scenes']}
        for entry in self.frames:
            self.path(entry['file'])

    def path(self, name):
        value = (self.directory/name).resolve()
        require(self.directory in value.parents and value.suffix.lower() in ('.png', '.jpg', '.jpeg'), 'Capture frame must stay inside the recording directory')
        require(value.is_file(), 'A capture frame is missing')
        return value

    def at(self, when):
        entry = self.frames[max(0, bisect.bisect_right(self.times, when)-1)]
        frame = load_frame(str(self.path(entry['file'])))
        require(frame.size == self.size, 'Capture dimensions changed during recording')
        return frame, entry

    def moment(self, scene_id, name):
        scene = self.scenes[scene_id]
        value = scene.get(name) if name in ('input', 'result') else next((m for m in scene.get('moments', []) if m['kind'] == name), None)
        require(value is not None, 'Missing reviewed moment: '+scene_id+'/'+name)
        self.path(value['file'])
        index = value['frameIndex']
        require(0 <= index < len(self.frames) and self.frames[index]['file'] == value['file'] and self.frames[index]['at'] == value['atMs'], 'Scene-map frame identity does not match the manifest')
        return value


def build_story(recording):
    story = []
    start = 4
    for item in SHOTS:
        identity, scene_id, moment_id, duration, layout, zh_title, zh_detail, en_title, en_detail = item
        moment = recording.moment(scene_id, moment_id)
        scene = recording.scenes[scene_id]
        crop = CROPS.get(identity, tuple(moment['crop'][k] for k in ('x', 'y', 'width', 'height')))
        if recording.en and identity == 'organize':
            crop = (540, 300, 800, 370)
        elif recording.en and identity == 'edit':
            crop = (825, 565, 590, 190)
        elif recording.en and identity == 'source':
            crop = (545, 460, 790, 155)
        elif recording.en and identity == 'note':
            crop = (825, 215, 585, 495)
        elif recording.en and identity == 'paper':
            crop = (825, 310, 585, 490)
        # A scene-map may carry a more precise language-specific editorial crop.
        crop = tuple(moment.get('editorialCrops', {}).get(identity, crop))
        end = moment['atMs']
        begin, play = end, 0
        if identity in ('organize', 'answer'):
            begin = max(scene['input']['atMs']+250, end-3600)
            play = min(4, (end-begin)/1000)
        elif identity in ('edit', 'activity', 'models'):
            begin = max(scene['startMs'], end-1600)
            play = (end-begin)/1000
        segments = []
        if identity == 'edit':
            # Two explicit insert cuts: editor identity -> added paragraph ->
            # actual Save control. Source time remains monotonic across cuts.
            segments = [
                {'start': 0, 'duration': 1.4, 'fromMs': end-2200, 'toMs': end-1600, 'playSeconds': .6, 'crop': (812, 8, 620, 142)},
                {'start': 1.4, 'duration': 4.2, 'fromMs': end-1600, 'toMs': end-300, 'playSeconds': 1.3, 'crop': crop},
                {'start': 5.6, 'duration': 1.4, 'fromMs': end-300, 'toMs': end+500, 'playSeconds': .8, 'crop': (825, 108, 590, 43)},
            ]
            begin, end, play = end-2200, end+500, 2.7
        story.append({'segments': segments, 'id': identity, 'scene': scene_id, 'moment': moment_id, 'start': start, 'duration': duration, 'layout': layout, 'title': en_title if recording.en else zh_title, 'detail': en_detail if recording.en else zh_detail, 'crop': crop, 'sourceStartMs': begin, 'sourceEndMs': end, 'playSeconds': play, 'holdSeconds': duration-play, 'sourceFrame': moment['file']})
        start += duration
    return story, start+5


def shot_frame(recording, shot, local_time):
    play = shot['playSeconds']
    ratio = min(1, local_time/play) if play else 1
    when = shot['sourceStartMs']+(shot['sourceEndMs']-shot['sourceStartMs'])*ratio
    crop = shot['crop']
    if shot.get('segments'):
        segment = next((v for v in shot['segments'] if v['start'] <= local_time < v['start']+v['duration']), shot['segments'][-1])
        ratio = min(1, max(0, (local_time-segment['start'])/segment['playSeconds']))
        when = segment['fromMs']+(segment['toMs']-segment['fromMs'])*ratio
        crop = segment['crop']
    source, entry = recording.at(when)
    im = canvas()
    brand(im)
    if shot['layout'] == 'privacy':
        paragraph(im, shot['title'], (100, 210), 65, 1600)
        paragraph(im, shot['detail'], (104, 420), 36, 1660, MUTED, 1.65)
        for i, value in enumerate(('本地工作区', '自选模型', '可选自托管同步') if not recording.en else ('Local workspace', 'Your model connection', 'Optional self-hosted sync')):
            text(im, value, (104, 680+i*73), 33, ACCENT)
        return im
    if shot['layout'] == 'split':
        end = paragraph(im, shot['title'], (74, 235), 64, 555)
        paragraph(im, shot['detail'], (78, max(490, end+55)), 31, 510, MUTED, 1.5)
        display_crop(im, source, crop, (670, 135, 1178, 860))
    else:
        text(im, shot['title'], (72, 114), fit(shot['title'], 49, 1775))
        display_crop(im, source, crop, (72, 215, 1776, 745))
        text(im, shot['detail'], (74, 1003), fit(shot['detail'], 30, 1774), MUTED)
    return im


def title_frame(en, ending=False):
    im = canvas()
    side = 108 if ending else 132
    logo = LOGO.resize((side, side), Image.Resampling.LANCZOS)
    im.paste(logo, ((W-side)//2, 200), logo)
    headline = ('Your knowledge.\nReady for what’s next.' if en else '让知识积累，\n让事情向前。') if not ending else 'AI Bro'
    lines = headline.split('\n')
    for i, line in enumerate(lines):
        size = 84 if not ending else 90
        text(im, line, ((W-font(size).getlength(line))/2, 395+i*110), size)
    lower = ('Your AI companion for knowledge and action.' if en else '你的知识与行动伙伴。') if not ending else ('Build from source  /  Download for Mac' if en else '从源代码构建  /  下载 Mac App')
    text(im, lower, ((W-font(32).getlength(lower))/2, 710), 32, ACCENT)
    if ending:
        disclosure = DISCLOSURE['en' if en else 'zh-CN']
        text(im, disclosure, ((W-font(23).getlength(disclosure))/2, 949), 23, MUTED)
    return im


def stamp(seconds):
    ms = round(seconds*1000)
    return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'


def write_director(output, recording, story, total):
    document = {'schemaVersion': 2, 'lang': recording.lang, 'duration': total, 'resolution': [W, H], 'fps': FPS, 'camera': 'Fixed crops; hard cuts; no pan or zoom', 'disclosure': DISCLOSURE[recording.lang], 'sourceRecording': str(recording.directory), 'shots': story}
    output.with_suffix('.storyboard.json').write_text(json.dumps(document, ensure_ascii=False, indent=2))
    lines = ['# AI Bro · fixed-camera product film', '', f'Duration: {total} seconds. Language: {recording.lang}.', '', 'Real isolated App UI, synthetic example documents and scripted model responses. Captured interactions retain their order. Result holds are editorial reading time, not model latency. No camera motion, fabricated UI or desktop capture.', '', '| Film | Shot | Actual source | Playback / reading hold |', '|---|---|---|---|']
    for shot in story:
        display_title = shot['title'].replace('\n', ' / ')
        lines.append(f"| {shot['start']}–{shot['start']+shot['duration']}s | {display_title} | {shot['sourceStartMs']/1000:.2f}–{shot['sourceEndMs']/1000:.2f}s; {shot['sourceFrame']} | {shot['playSeconds']:.1f}s / {shot['holdSeconds']:.1f}s |")
    lines += ['', 'The privacy statement is an editorial information card, not a captured settings panel. It distinguishes locally stored workspace data from model requests sent to the selected provider.', '', 'The visible 1 sec / 3 sec receipts come from scripted demonstration responses. They are not performance measurements. The retired rushed teaser and mechanically timed tour are not current delivery formats.', '', 'The edit shot contains three fixed detail views: editor title and tabs, the actual added paragraph, then the actual Save button. No pixels inside the source UI are rewritten.', '', 'Final disclosure: '+DISCLOSURE[recording.lang]]
    output.with_suffix('.storyboard.md').write_text('\n'.join(lines)+'\n')
    subtitles = [f"{i+1}\n{stamp(s['start'])} --> {stamp(s['start']+s['duration']-.05)}\n{s['title']}\n{s['detail']}\n" for i, s in enumerate(story)]
    output.with_suffix('.srt').write_text('\n'.join(subtitles))
    captions = ['WEBVTT', '']
    for item in subtitles:
        parts = item.split('\n')
        parts[1] = parts[1].replace(',', '.')
        captions.append('\n'.join(parts))
    captions.append(f"{stamp(total-5).replace(',', '.')} --> {stamp(total).replace(',', '.')}\n{DISCLOSURE[recording.lang]}\n")
    output.with_suffix('.vtt').write_text('\n'.join(captions))


def audio_bed(filename, duration):
    # Quiet original synthesized tones; no third-party soundtrack or microphone.
    sr, frequencies = 48000, [130.8128, 164.8138, 195.9977, 246.9417]
    length = round(duration*sr)
    with wave.open(str(filename), 'wb') as out:
        out.setparams((2, 2, sr, 0, 'NONE', 'not compressed'))
        for base in range(0, length, sr):
            block = bytearray()
            for n in range(base, min(base+sr, length)):
                t = n/sr
                fade = min(1, t/3, max(0, (duration-t)/3))
                value = sum(math.sin(2*math.pi*f*t)*(.52+.48*math.sin(t*.13+j*.8)**2)/(j+5) for j, f in enumerate(frequencies))*.012*fade
                sample = int(value*32767)
                block.extend(struct.pack('<hh', sample, int(sample*.98)))
            out.writeframesraw(block)


def main():
    global FONT, LOGO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scene-map', type=Path)
    parser.add_argument('--font')
    parser.add_argument('--preview', action='store_true', help='Write five review frames and storyboard, without encoding')
    parser.add_argument('--silent', action='store_true', help='Omit the original quiet sound bed')
    parser.add_argument('--teaser', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    require(not args.teaser, 'The rushed teaser cut was retired. Use the readable fixed-camera film.')
    recording = Recording(args.recording, args.scene_map)
    FONT = locate_font(args.font)
    require(Path(FONT).is_file(), 'Set --font to a CJK-capable font file')
    with Image.open(ROOT/'ai-bro-icon.png') as logo:
        LOGO = logo.convert('RGBA')
    story, total = build_story(recording)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_director(args.output, recording, story, total)
    # Validate all reviewed end-frame crop geometry even in preview-only mode.
    for shot in story:
        shot_frame(recording, shot, shot['duration'])
    title_frame(recording.en).save(args.output.with_suffix('.poster.jpg'), quality=95)
    if args.preview:
        selected = ('organize', 'edit', 'answer', 'activity', 'models')
        for i, identity in enumerate(selected):
            shot = next(s for s in story if s['id'] == identity)
            shot_frame(recording, shot, 4.5 if identity == 'edit' else shot['duration']).save(args.output.parent/f'{recording.lang}-preview-{i+1}-{identity}.jpg', quality=95)
        print(json.dumps({'previews': 5, 'directory': str(args.output.parent), 'storyboard': str(args.output.with_suffix('.storyboard.md')), 'seconds': total}))
        return
    web_output = args.output.with_name(args.output.stem+'.web.mp4')
    require(not args.output.exists() and not web_output.exists(), 'Refusing to overwrite a film')
    ffmpeg = shutil.which('ffmpeg')
    require(ffmpeg is not None, 'ffmpeg is required')
    temporary = args.output.with_name('.'+args.output.stem+'.encoding.mp4')
    require(not temporary.exists(), 'An interrupted encoding exists; inspect or remove it before retrying')
    bed = args.output.with_suffix('.wav')
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{W}x{H}', '-framerate', str(FPS), '-i', 'pipe:0']
    if not args.silent:
        require(not bed.exists(), 'Refusing to overwrite an existing audio file')
        audio_bed(bed, total)
        command += ['-i', str(bed)]
    command += ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
    if not args.silent:
        command += ['-c:a', 'aac', '-b:a', '128k', '-shortest']
    command += ['-movflags', '+faststart', '-metadata', 'title=AI Bro | '+('English' if recording.en else 'Chinese'), '-metadata', 'comment=Real App UI. Isolated synthetic workspace. Scripted model responses. Fixed-camera editorial cuts and extended result holds.', str(temporary)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    cache_key, cached = None, None
    try:
        for n in range(round(total*FPS)):
            sec = n/FPS
            shot = next((s for s in story if s['start'] <= sec < s['start']+s['duration']), None)
            if shot:
                local = sec-shot['start']
                sample = local if shot.get('segments') else min(local, shot['playSeconds'])
                key = (shot['id'], round(sample*FPS))
                if key != cache_key:
                    cached = shot_frame(recording, shot, sample).tobytes()
            else:
                key = ('outro' if sec >= total-5 else 'intro',)
                if key != cache_key:
                    cached = title_frame(recording.en, sec >= total-5).tobytes()
            cache_key = key
            process.stdin.write(cached)
            if n % (FPS*10) == 0:
                print(f'{recording.lang}: {sec:.0f}s / {total}s', flush=True)
        process.stdin.close()
        require(process.wait() == 0, 'ffmpeg encode failed')
        temporary.rename(args.output)
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        if not args.silent:
            bed.unlink(missing_ok=True)
    # Web rendition keeps enough pixels for the enlarged product text. The
    # original 1080p master remains available; neither file is silently replaced.
    web_temporary = web_output.with_name('.'+web_output.stem+'.encoding.mp4')
    require(not web_temporary.exists(), 'An interrupted web encoding already exists')
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(args.output), '-vf', 'scale=1600:900:flags=lanczos,fps=24', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '80k', '-movflags', '+faststart', str(web_temporary)], check=True)
    web_temporary.rename(web_output)
    print(json.dumps({'film': str(args.output), 'web': str(web_output), 'poster': str(args.output.with_suffix('.poster.jpg')), 'vtt': str(args.output.with_suffix('.vtt')), 'seconds': total, 'language': recording.lang}))


if __name__ == '__main__':
    main()
