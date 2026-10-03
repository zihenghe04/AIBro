import SwiftUI
import ImageIO

/// Offline-only image: never accepts a URL or starts a network request. The
/// server normalizes remote icons to 64px PNG; persisted data is checked again.
struct NativeQuickLinkIcon:View {
    let dataURL:String?
    let site:String
    @State private var image:CGImage?
    private struct Raster:@unchecked Sendable {let image:CGImage}
    static func decode(_ value:String?)->CGImage? {
        guard let value,value.hasPrefix("data:image/png;base64,"),value.utf8.count<=43714,
              let bytes=Data(base64Encoded:String(value.dropFirst(22))),bytes.count<=32768,
              bytes.starts(with:[137,80,78,71,13,10,26,10]),
              let source=CGImageSourceCreateWithData(bytes as CFData,[kCGImageSourceShouldCache:false] as CFDictionary),
              CGImageSourceGetCount(source)==1,
              let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let width=props[kCGImagePropertyPixelWidth] as? Int,let height=props[kCGImagePropertyPixelHeight] as? Int,
              (1...64).contains(width),(1...64).contains(height) else{return nil}
        return CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:64,kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
    }
    var body:some View {
        Group {
            if let image {Image(decorative:image,scale:2).resizable().interpolation(.high).scaledToFit().padding(5)}
            else {Text(String(site.first ?? "·").uppercased()).font(.system(size:15,weight:.medium))}
        }.frame(width:34,height:34).background(.primary.opacity(0.06),in:RoundedRectangle(cornerRadius:9)).accessibilityHidden(true)
            .task(id:dataURL){
                image=nil;let value=dataURL
                let result=await Task.detached(priority:.utility){Self.decode(value).map{Raster(image:$0)}}.value
                guard !Task.isCancelled else{return};image=result?.image
            }
    }
}
