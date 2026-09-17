import Foundation

@main struct VectorStoreTests {
    static func main() throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]), mode=CommandLine.arguments[2]
        let store=NativeVectorStore(folder:folder), profile=String(repeating:"a",count:64), other=String(repeating:"b",count:64)
        func record(_ id:String)->[String:Any] { ["id":id,"hash":String(repeating:"c",count:64),"vector":[1.0,0.5],"updatedAt":1234.0,"token":"must-not-be-stored"] }
        if mode == "write" {
            try store.write(profile,puts:[record("one"),record("two")],removes:[])
            try store.write(other,puts:[record("one")],removes:[])
        } else {
            let loaded=try store.load(profile)
            precondition(loaded.count==2 && loaded.allSatisfy{$0["token"] == nil})
            let otherBefore=try store.load(other);precondition(otherBefore.count==1)
            var invalid=record("bad");invalid["vector"]=[Double.nan]
            do {try store.write(profile,puts:[record("three"),invalid],removes:["one"]);fatalError("Accepted invalid batch")}
            catch NativeVectorStore.Failure.invalidRecord {}
            let unchanged=try store.load(profile);precondition(unchanged.count==2,"Failed batch changed existing records")
            do {_ = try store.load("../../outside");fatalError("Accepted unsafe profile")}
            catch NativeVectorStore.Failure.invalidRecord {}
            try store.write(profile,puts:[record("three")],removes:["one"])
            let changed=try store.load(profile),otherAfter=try store.load(other)
            precondition(changed.compactMap{$0["id"] as? String}.sorted()==["three","two"])
            precondition(otherAfter.count==1,"Profile deletion crossed model boundaries")
            let attrs=try FileManager.default.attributesOfItem(atPath:folder.appendingPathComponent("vector-index.sqlite3").path)
            precondition((attrs[.posixPermissions] as? NSNumber)?.intValue==0o600)
        }
        print("Native vector store \(mode): PASS")
    }
}
