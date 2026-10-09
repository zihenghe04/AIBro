import test from 'node:test';
import assert from 'node:assert/strict';
import { editAgendaEvent, eventLocalInput, eventLocalInstant } from '../src/agenda-edit.js';
import { recurringOccurrences } from '../src/agenda-recurrence.js';
import { parseICS, agendaNote, readEvent, eventsFor } from '../src/agenda.js';
import { Store, MemoryAdapter } from '../src/store.js';
const stamp = s => Date.parse(s);
const weekly = () => ({title:'读书会',start:stamp('2030-03-06T15:00:00+08:00'),end:stamp('2030-03-06T16:00:00+08:00'),timeZone:'Asia/Shanghai',
  recurrence:{frequency:'weekly',interval:1,weekdays:[4],count:4,until:null},reminderMinutes:15,source:'desktop',documentID:'source-note',excluded:[],completed:[]});
const rows = e => recurringOccurrences(e,e.start-1,e.start+35*86400000);
test('whole-series time edit keeps rule and remaps completed/excluded by occurrence date', () => {
  const before=weekly(), original=rows(before);before.excluded=[original[1].start];before.completed=[original[0].start];
  const untouched=structuredClone(before), next=editAgendaEvent(before,{start:before.start+3600000,end:before.end+5400000},{scope:'series'});
  assert.deepEqual(before,untouched);assert.deepEqual(next.recurrence,before.recurrence);
  assert.equal(next.completed[0],before.completed[0]+3600000);assert.equal(next.excluded[0],before.excluded[0]+3600000);
  assert.equal(rows(next).length,3);assert.equal(next.source,'desktop');assert.equal(next.documentID,'source-note');
  assert.equal(next.end-next.start,90*60000);
  assert.throws(()=>editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000}),/整个系列/);
  assert.throws(()=>editAgendaEvent(before,{start:before.start+86400000,end:before.end+86400000},{scope:'series'}),/首次日期/);
});
test('metadata-only edits keep recurrence and all exception metadata unchanged',()=>{
  const before=weekly();before.excluded=[before.start+7*86400000];before.completed=[before.start];
  const next=editAgendaEvent(before,{title:'改名',location:'图书馆',reminderMinutes:null});
  assert.deepEqual(next.excluded,before.excluded);assert.deepEqual(next.completed,before.completed);assert.deepEqual(next.recurrence,before.recurrence);
  assert.equal(next.reminderMinutes,null);assert.equal(next.start,before.start);
});
test('until preserves the final included date when shifting time beyond the former cutoff',()=>{
  const before=weekly();before.recurrence={...before.recurrence,count:null,until:before.start+2*7*86400000};
  before.completed=[before.recurrence.until];
  const next=editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000,editScope:'series'});
  assert.equal(rows(next).length,3);assert.equal(next.recurrence.until,before.recurrence.until+3600000);
  assert.equal(next.completed[0],next.recurrence.until);assert.equal(next.editScope,undefined);
});
test('DST exception mapping uses recurrence engine wall time rather than a fixed UTC shift',()=>{
  const before={...weekly(),timeZone:'America/New_York',start:stamp('2026-03-01T01:30:00-05:00'),end:stamp('2026-03-01T02:30:00-05:00'),recurrence:{frequency:'weekly',interval:1,weekdays:[1],count:3,until:null}};
  before.completed=[stamp('2026-03-08T01:30:00-05:00')];
  const next=editAgendaEvent(before,{start:stamp('2026-03-01T03:30:00-05:00'),end:stamp('2026-03-01T04:30:00-05:00')},{scope:'series'});
  assert.equal(next.completed[0],stamp('2026-03-08T03:30:00-04:00'));
  assert.equal(eventLocalInput(next.completed[0],next.timeZone),'2026-03-08T03:30');
  assert.throws(()=>eventLocalInstant('2026-03-08T02:30',next.timeZone),/夏令时/);
  assert.throws(()=>eventLocalInstant('2026-11-01T01:30',next.timeZone),/夏令时/);
});
test('canonical repeating creation is validated without reducing it to a single appointment',()=>{
  const next=editAgendaEvent(null,weekly());assert.equal(rows(next).length,4);
  assert.throws(()=>editAgendaEvent(null,{...weekly(),recurrence:{frequency:'weekly',interval:0,weekdays:[4]}}),/规则无效/);
  assert.throws(()=>editAgendaEvent(null,{...weekly(),end:weekly().start}),/结束时间/);
});
test('imported ICS keeps UID/RRULE/EXDATE and agrees with edited start/end on roundtrip',async()=>{
  const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-weekly\r\nSUMMARY:示例课表\r\nDTSTART;TZID=Asia/Shanghai:20300306T150000\r\nDTEND;TZID=Asia/Shanghai:20300306T160000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Asia/Shanghai:20300313T150000\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const result=parseICS(ics);assert.deepEqual(result.warnings,[]);const before=result.events[0];
  before.completed=[before.start];
  const next=editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000,title:'手机改过的课表'}, {scope:'series'});
  const round=parseICS(next.ics);assert.deepEqual(round.warnings,[]);assert.equal(round.events[0].start,next.start);assert.equal(round.events[0].end,next.end);
  assert.match(next.ics,/UID:synthetic-weekly/);assert.match(next.ics,/FREQ=WEEKLY;COUNT=4/);assert.match(next.ics,/20300313T080000Z/);
  assert.equal(next.completed[0],next.start);
  const store=await new Store(new MemoryAdapter()).load();const note=agendaNote(next);await store.put('notes',note);
  const events=eventsFor(store,next.start-1,next.start+30*86400000);assert.equal(events.length,3);assert.equal(events[0].reminderAt,null);
  assert.equal(readEvent(note).start,next.start);
  assert.throws(()=>editAgendaEvent(before,{start:before.start+86400000,end:before.end+86400000},{scope:'series'}),/首次日期/);
});

test('legacy missing timezone uses the same UTC wall clock on edit',()=>{
  const before=weekly();delete before.timeZone;
  const next=editAgendaEvent(before,{title:'改名'});assert.equal(next.timeZone,'UTC');assert.equal(next.start,before.start);
  before.recurrence.until=before.start+14*86400000;before.recurrence.count=null;
  const moved=editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000},{scope:'series'});
  assert.equal(moved.recurrence.until,before.recurrence.until+3600000);
});
test('ICS canceled final date does not shorten UNTIL and UTC EXDATE stays absolute',()=>{
  const result=parseICS('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:until-excluded\r\nSUMMARY:测试\r\nDTSTART;TZID=Asia/Shanghai:20300306T150000\r\nDTEND;TZID=Asia/Shanghai:20300306T160000\r\nRRULE:FREQ=WEEKLY;UNTIL=20300320T070000Z\r\nEXDATE:20300320T070000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const before=result.events[0],next=editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000},{scope:'series'});
  assert.match(next.ics,/UNTIL=20300320T080000Z/);assert.match(next.ics,/EXDATE:20300320T080000Z/);
  const round=parseICS(next.ics);assert.deepEqual(round.warnings,[]);
});
test('imported series crossing DST refuses time changes instead of reviving canceled dates',()=>{
  const result=parseICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:dst-gap\r\nSUMMARY:dst-gap\r\nDTSTART;TZID=America/New_York:20260301T023000\r\nDTEND;TZID=America/New_York:20260301T033000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=America/New_York:20260308T033000\r\nLOCATION:\r\nDESCRIPTION:\r\nEND:VEVENT\r\nEND:VCALENDAR");
  const before=result.events[0],backup=structuredClone(before);
  assert.throws(()=>editAgendaEvent(before,{start:before.start+3600000,end:before.end+3600000},{scope:'series'}),/夏令时/);
  assert.deepEqual(before,backup);
});
