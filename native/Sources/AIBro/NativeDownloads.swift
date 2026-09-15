import AppKit
import WebKit
extension Workspace:WKDownloadDelegate {
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload){download.delegate=self}
    func webView(_ webView:WKWebView,decidePolicyFor response:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void){decisionHandler(response.canShowMIMEType ? .allow:.download)}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload){download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void){let panel=NSSavePanel();panel.nameFieldStringValue=(suggestedFilename as NSString).lastPathComponent;panel.begin{completionHandler($0 == .OK ? panel.url:nil)}}
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?){self.error="下载失败：\(error.localizedDescription)"}
}
extension Workspace {
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){let alert=NSAlert();alert.messageText="AI Bro";alert.informativeText=message;alert.addButton(withTitle:"好");if let window=webView.window {alert.beginSheetModal(for:window){_ in completionHandler()}}else{alert.runModal();completionHandler()}}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){let alert=NSAlert();alert.messageText="AI Bro";alert.informativeText=message;alert.addButton(withTitle:"取消");alert.addButton(withTitle:"确认");if let window=webView.window{alert.beginSheetModal(for:window){completionHandler($0 == .alertSecondButtonReturn)}}else{completionHandler(alert.runModal() == .alertSecondButtonReturn)}}
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){let alert=NSAlert();alert.messageText=prompt;let input=NSTextField(string:defaultText ?? "");input.frame=NSRect(x:0,y:0,width:320,height:26);alert.accessoryView=input;alert.addButton(withTitle:"确认");alert.addButton(withTitle:"取消");if let window=webView.window{alert.beginSheetModal(for:window){completionHandler($0 == .alertFirstButtonReturn ? input.stringValue:nil)}}else{completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue:nil)}}
}
