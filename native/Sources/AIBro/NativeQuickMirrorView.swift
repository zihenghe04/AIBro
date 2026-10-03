import AppKit
import SwiftUI
import AVFoundation

enum NativeQuickMirrorMotion {
    static func zoom(_ value: Double) -> Double { value.isFinite ? max(1,min(2.6,value)) : 1 }
    static func wheel(_ value: Double,delta: Double) -> Double { zoom(value - (delta.isFinite ? delta : 0) * 0.002) }
    static func pixelOpacity(index: Int,elapsed: Double) -> Double {
        let row = index / 10,column = index % 10
        let delay = Double(row*24 + column*13 + ((row+column)%3)*17) / 1000
        return max(0,min(1,1-(elapsed-delay)/0.62))
    }
}

private struct NativeQuickCameraPreview: NSViewRepresentable {
    let session: AVCaptureSession?
    @Binding var zoom: Double
    final class Preview: NSView {
        let preview = AVCaptureVideoPreviewLayer()
        var onZoom: ((Double) -> Void)?
        var value: Double = 1
        override init(frame: NSRect) { super.init(frame:frame);wantsLayer = true;layer?.addSublayer(preview);preview.videoGravity = .resizeAspectFill }
        required init?(coder: NSCoder) { nil }
        override func layout() { super.layout();preview.frame = bounds }
        override func magnify(with event: NSEvent) { onZoom?(NativeQuickMirrorMotion.zoom(value*(1+event.magnification))) }
        override func scrollWheel(with event: NSEvent) {
            if event.modifierFlags.contains(.control) { onZoom?(NativeQuickMirrorMotion.wheel(value,delta:event.scrollingDeltaY)) }
            else { super.scrollWheel(with:event) }
        }
    }
    func makeNSView(context: Context) -> Preview { Preview() }
    func updateNSView(_ view: Preview,context: Context) {
        view.preview.session = session;view.value = NativeQuickMirrorMotion.zoom(zoom)
        view.onZoom = { zoom = $0 }
        CATransaction.begin();CATransaction.setDisableActions(true)
        view.preview.setAffineTransform(CGAffineTransform(scaleX:-view.value,y:view.value));CATransaction.commit()
    }
    static func dismantleNSView(_ view: Preview,coordinator: ()) { view.onZoom = nil;view.preview.session = nil }
}

struct NativeQuickMirrorCard: View {
    @ObservedObject var store: NativeQuickMirrorStore
    @Environment(\.nativeQuickWidgetContext) private var widget
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealAt: Date?
    @State private var ripples: [Ripple] = []
    @State private var motionGeneration = UUID()
    @State private var lastHover: CGPoint?
    @State private var lastRippleAt = Date.distantPast
    private struct Ripple { let point: CGPoint;let date: Date;let speed: Double }
    private var compact: Bool { !widget.isDetail && widget.size == "mini" }
    private var height: CGFloat { widget.isDetail ? 260 : compact ? 38 : widget.size == "small" ? 80 : 116 }
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            ZStack {
                cover.scaleEffect(lastHover != nil && !reduceMotion && !store.active ? 1.025 : 1)
                    .animation(reduceMotion ? nil : .easeOut(duration:0.24),value:lastHover != nil)
                if store.active {
                    NativeQuickCameraPreview(session:store.session,zoom:$store.zoom)
                    if !reduceMotion,let revealAt {
                        TimelineView(.animation(minimumInterval:1/60)) { timeline in
                            Canvas { context,size in
                                let elapsed = timeline.date.timeIntervalSince(revealAt)
                                for index in 0..<80 {
                                    let rect = CGRect(x:CGFloat(index%10)*size.width/10,y:CGFloat(index/10)*size.height/8,width:size.width/10+1,height:size.height/8+1)
                                    context.fill(Path(rect),with:.color(.black.opacity(NativeQuickMirrorMotion.pixelOpacity(index:index,elapsed:elapsed))))
                                }
                            }
                        }.allowsHitTesting(false).accessibilityHidden(true)
                    }
                } else {
                    Button { Task { await store.toggle() } } label: {
                        VStack(spacing:compact ? 2 : 6) {
                            Image(systemName:store.starting ? "camera.badge.ellipsis" : "camera").font(.system(size:compact ? 15 : 24,weight:.light))
                            if !compact { Text(store.starting ? nativeUI("取消开启", "Cancel opening") : nativeUI("打开镜子", "Open mirror")).font(.caption.weight(.medium)) }
                        }.padding(8).foregroundStyle(.white).shadow(color:.black.opacity(0.6),radius:8)
                        .frame(maxWidth:.infinity,maxHeight:.infinity)
                    }.buttonStyle(.plain).disabled(!store.controlsEnabled)
                    .accessibilityLabel(store.starting ? nativeUI("取消开启摄像头", "Cancel opening camera") : nativeUI("打开镜子，仅此操作使用摄像头", "Open mirror; uses the camera only when started"))
                }
                if !reduceMotion,!store.active,!ripples.isEmpty {
                    TimelineView(.animation(minimumInterval:1/60)) { timeline in
                        Canvas { context,_ in
                            for ripple in ripples {
                                let p = min(1,max(0,timeline.date.timeIntervalSince(ripple.date)/1.25)),ease = 1-pow(1-p,3)
                                for ring in 0..<3 {
                                    let radius = 6+ease*(34+ripple.speed*1.8)+Double(ring)*7
                                    let rect = CGRect(x:ripple.point.x-radius,y:ripple.point.y-radius,width:radius*2,height:radius*2)
                                    context.stroke(Path(ellipseIn:rect),with:.color(.white.opacity(max(0,(1-p)*(0.17-Double(ring)*0.035)))),lineWidth:max(0.65,1.55-p))
                                }
                            }
                        }
                    }.allowsHitTesting(false).accessibilityHidden(true)
                }
                VStack { Spacer();HStack(spacing:8) {
                    if store.active {
                        if !compact { Text(store.cameraName ?? nativeUI("镜子", "Mirror")).font(.system(size:10)).lineLimit(1) }
                        Spacer()
                        Button { store.stop() } label: { Image(systemName:"camera.slash.fill").padding(7) }.buttonStyle(.plain)
                            .help(nativeUI("关闭摄像头", "Turn camera off")).accessibilityLabel(nativeUI("关闭摄像头", "Turn camera off"))
                    } else { Spacer() }
                    options
                }.foregroundStyle(.white).padding(.horizontal,compact ? 3 : 8).padding(.top,compact ? 0 : 10).padding(.bottom,compact ? 2 : 5)
                    .background(LinearGradient(colors:[.clear,.black.opacity(0.55)],startPoint:.top,endPoint:.bottom)) }
            }
            .frame(height:height).clipShape(RoundedRectangle(cornerRadius:14))
            .onContinuousHover { phase in
                guard !reduceMotion,!store.active,store.controlsEnabled else{return}
                switch phase {
                case .active(let point):
                    let now = Date(),speed = lastHover.map { hypot(point.x-$0.x,point.y-$0.y) } ?? 0
                    lastHover = point
                    if speed > 1.5,now.timeIntervalSince(lastRippleAt) > 0.042 {
                        lastRippleAt = now;ripples.removeAll { now.timeIntervalSince($0.date)>1.25 }
                        ripples.append(.init(point:point,date:now,speed:min(18,speed)));if ripples.count>18 { ripples.removeFirst() };motionGeneration = UUID()
                    }
                case .ended: lastHover = nil
                }
            }
            if store.active && !compact {
                HStack(spacing:8) { Slider(value:$store.zoom,in:1...2.6).accessibilityLabel(nativeUI("镜子缩放", "Mirror zoom"));Text(String(format:"%.1f×",store.zoom)).font(.caption.monospacedDigit()).frame(width:34) }
            }
            if let error = store.error {
                if widget.isDetail {
                    Text(error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)
                    if !store.ready { Button(nativeUI("重新读取设置", "Reload settings")) { Task { await store.reload() } }.buttonStyle(.plain).font(.caption) }
                } else { Button(nativeUI("查看摄像头状态", "Review camera status")) { widget.expand?() }.buttonStyle(.plain).font(.system(size:10)).foregroundStyle(.orange) }
            }
        }
        .onChange(of:store.active) { _,active in
            ripples = [];lastHover = nil;revealAt = active && !reduceMotion ? Date() : nil;motionGeneration = UUID()
        }
        .onChange(of:reduceMotion) { _,value in if value { ripples = [];revealAt = nil;motionGeneration = UUID() } }
        .task(id:motionGeneration) {
            do { try await Task.sleep(nanoseconds:1_300_000_000) } catch { return }
            ripples = [];revealAt = nil
        }
        .onDisappear { store.stop();ripples = [];revealAt = nil;lastHover = nil }
    }
    @ViewBuilder private var cover: some View {
        if let image = store.cover,store.available {
            GeometryReader { geometry in Image(nsImage:image).resizable().scaledToFill().frame(width:geometry.size.width,height:geometry.size.height).clipped() }
        } else {
            RoundedRectangle(cornerRadius:14).fill(LinearGradient(colors:[.white.opacity(0.14),.white.opacity(0.035)],startPoint:.topLeading,endPoint:.bottomTrailing))
        }
    }
    private var options: some View {
        Menu {
            Section(nativeUI("摄像头", "Camera")) {
                Button { Task { await store.chooseCamera(nil) } } label: { Label(nativeUI("自动选择", "Automatic"),systemImage:store.preferredCameraID == nil ? "checkmark" : "camera") }
                ForEach(store.devices) { device in
                    Button { Task { await store.chooseCamera(device.id) } } label: { Label(device.name,systemImage:store.preferredCameraID == device.id ? "checkmark" : "camera") }
                }
                if let preferred = store.preferredCameraID,!store.devices.contains(where:{$0.id == preferred}) { Text(nativeUI("偏好相机未连接，开启时尝试可用设备", "Preferred camera disconnected; available devices will be tried when started")) }
                if store.devices.isEmpty { Text(nativeUI("开启并授权后显示相机列表", "Cameras appear after starting and granting access")) }
                Button(nativeUI("刷新相机列表", "Refresh camera list")) { Task { await store.refreshDevices() } }
            }
            Divider()
            Button(nativeUI("更换封面…", "Change cover…")) { store.chooseCover() }
            if store.cover != nil { Button(nativeUI("恢复默认封面", "Use default cover")) { Task { await store.resetCover() } } }
        } label: { Image(systemName:"ellipsis").font(.system(size:12,weight:.semibold)).padding(6).foregroundStyle(.white) }
        .menuStyle(.borderlessButton).fixedSize().disabled(!store.controlsEnabled)
        .help(nativeUI("相机与封面", "Camera and cover")).accessibilityLabel(nativeUI("相机与封面", "Camera and cover"))
    }
}
