// Typecheck-only host boundary. These stubs never run a browser or a device.
import Foundation
import AppKit
import WebKit
func nativeUI(_ zh:String,_ en:String)->String{en}
final class NativeL10n {static let shared=NativeL10n();func setLanguage(_ s:String){};static func normalize(_ s:String)->String{s}}
struct SpeechHostSnapshot {var privateMode:Bool?=false;var modalOpen:Bool?=false}
struct SpeechHostEvent {var deleted=false,id="",title="",documentID="",start=Date()}
@MainActor final class SpeechHostAgenda {var events:[SpeechHostEvent]=[];var preferences=(notifications:false,unused:false);var notificationStatus="";var hasUnsavedEditorDrafts=false;func requestNotifications()async{}}
struct BrowserFailure:Error {var details:[String:Any]=[:];var code=""}
@MainActor final class SpeechHostBrowser {func request(_ request:[String:Any],root:URL,workspaceOrigin:URL?)async throws->[String:Any]{[:]}}
final class NativeVectorStore {enum Failure:Error{case invalidRecord};init(folder:URL){};func load(_ profile:String)throws->[String:Any]{[:]};func write(_ profile:String,puts:[[String:Any]],removes:[String])throws{}}
@MainActor final class Workspace {
 var origin:URL?,ready=false,snapshot:SpeechHostSnapshot?
 let web=WKWebView(),root=URL(fileURLWithPath:"/synthetic")
 let agenda=SpeechHostAgenda(),browser=SpeechHostBrowser()
 let agendaAgent=AgendaAgentController()
 func navigateWorkspace(_ view:String,section:String?,requestId:String?)async->Bool{false}
 func reviewAgendaProposal(_ value:[String:Any])throws{}
 func draftAgenda(_ id:String)throws{}
 func openLinkedAgenda(_ id:String)throws{}
 func setAppearance(_ value:String){}
}
