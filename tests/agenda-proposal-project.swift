import Foundation

@main struct AgendaProposalProjectTests {
    static func main() throws {
        var count=0
        func check(_ value:Bool,_ label:String){precondition(value,label);count+=1;print("PASS",label)}
        let ids=["course","other"]
        func resolve(_ proposal:[String:Any],source:String?=nil,conversation:String?="course",available:[String]?=nil)throws->String {
            try AgendaProposalProject.resolve(proposal,sourceProjectID:source,conversationProjectID:conversation,availableProjectIDs:available ?? ids)
        }
        check(try resolve(["projectID":"course"])=="course","normalized message project reaches native event identity")
        check(try resolve([:])=="course","legacy proposal inherits its source conversation")
        check(try resolve(["projectID":NSNull()])=="","explicit independent proposal never inherits conversation")
        check(try resolve(["projectID":""])=="","explicit empty identity remains independent")
        check(try resolve(["projectId":"other"])=="other","explicit other visible project wins over conversation")
        check(try resolve(["courseId":"course"])=="course","legacy course ID normalizes to real project ID")
        check(try resolve([:],source:"course",conversation:"other")=="course","note proposal remains in original note project")
        check(try resolve([:],conversation:nil)=="","unbound source never guesses current selection")
        for proposal in [["projectID":"missing"],["projectID":"course","projectId":"other"],["projectID":7]] as [[String:Any]] {
            do{_ = try resolve(proposal);fatalError("invalid association accepted")}catch{}
        }
        check(true,"invalid conflicting or missing project identity rejects native draft")
        do{_ = try resolve(["projectID":"course"],available:["course","course"]);fatalError("duplicate project accepted")}catch{}
        check(true,"duplicate project identity is unavailable")
        for project in ["other",""] {
            do{_ = try resolve(["projectID":project],source:"course");fatalError("note project changed")}catch{}
        }
        check(true,"cross-project and unlinked source-note proposals reject before saving")
        print("\(count) agenda proposal project checks passed")
    }
}
