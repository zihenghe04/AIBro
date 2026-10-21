import Foundation
import SQLite3

@main struct VectorStoreTests {
    static func main() throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]), mode=CommandLine.arguments[2]
        let store=NativeVectorStore(folder:folder), profile=String(repeating:"a",count:64), other=String(repeating:"b",count:64)
        func record(_ id:String)->[String:Any] { ["id":id,"hash":String(repeating:"c",count:64),"vector":[1.0,0.5],"updatedAt":1234.0,"token":"must-not-be-stored"] }
        if mode == "parity" || mode == "legacy" { try parity(store:store,folder:folder,profile:profile,legacy:mode == "legacy");print("Native vector store \(mode): PASS");return }
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
            let summary=try store.summary(profile)
            precondition(summary.count==2 && summary.allSatisfy{$0["vector"] == nil && $0["dimensions"] as? Int == 2},"Summary must carry metadata only")
        }
        print("Native vector store \(mode): PASS")
    }
    // Same vectors and query as the page: scores must match VectorIndex.cosine, before and after legacy migration.
    static func parity(store:NativeVectorStore,folder:URL,profile:String,legacy:Bool) throws {
        let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[3]))) as! [String:Any]
        let rows=fixture["rows"] as! [[String:Any]],query=fixture["query"] as! [Double],expected=fixture["expected"] as! [String:Double]
        if legacy {
            try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            var db:OpaquePointer?;precondition(sqlite3_open(folder.appendingPathComponent("vector-index.sqlite3").path,&db)==SQLITE_OK)
            precondition(sqlite3_exec(db,"CREATE TABLE vectors (profile TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (profile, id))",nil,nil,nil)==SQLITE_OK)
            for row in rows+[["id":"broken"]] {
                var record=row;record["profile"]=profile
                let text=row["vector"] == nil ? "{not json" : String(decoding:try JSONSerialization.data(withJSONObject:record),as:UTF8.self)
                let sql="INSERT INTO vectors VALUES ('\(profile)', '\(row["id"] as! String)', '\(text.replacingOccurrences(of:"'",with:"''"))')"
                precondition(sqlite3_exec(db,sql,nil,nil,nil)==SQLITE_OK)
            }
            sqlite3_close(db)
        } else {
            try store.write(profile,puts:rows,removes:[])
        }
        let summary=try store.summary(profile)
        precondition(summary.count==rows.count,"Migration must keep every valid row and skip unreadable ones")
        if legacy {
            let names=try FileManager.default.contentsOfDirectory(atPath:folder.path)
            precondition(names.filter{$0.hasPrefix("vector-index.sqlite3.bak-")}.count==1,"Legacy file must be backed up once before migration")
            var db:OpaquePointer?;sqlite3_open(folder.appendingPathComponent("vector-index.sqlite3").path,&db);var stmt:OpaquePointer?
            sqlite3_prepare_v2(db,"SELECT count(*) FROM vectors",-1,&stmt,nil);sqlite3_step(stmt)
            precondition(sqlite3_column_int(stmt,0)==Int32(rows.count+1),"Legacy table stays readable for older builds");sqlite3_finalize(stmt)
            sqlite3_close(db)
        }
        let loaded=Dictionary(uniqueKeysWithValues:try store.load(profile).map{($0["id"] as! String,$0["vector"] as! [Double])})
        // Legacy rows hold whatever JSONSerialization printed; migration must keep exactly what the old load returned.
        func original(_ row:[String:Any]) throws -> [Double] {
            guard legacy else {return row["vector"] as! [Double]}
            return (try JSONSerialization.jsonObject(with:JSONSerialization.data(withJSONObject:row)) as! [String:Any])["vector"] as! [Double]
        }
        for row in rows {let want=try original(row);precondition(loaded[row["id"] as! String]! == want,"Stored vectors must be lossless")}
        var entries=Dictionary(uniqueKeysWithValues:rows.map{($0["id"] as! String,$0["hash"] as! String)})
        entries["chunk-03"]=String(repeating:"f",count:64)
        let scored=try store.search(profile,query:query,entries:entries)
        precondition(scored.count==rows.count-1 && !scored.contains{$0["id"] as? String == "chunk-03"},"Changed hashes must not be scored")
        for item in scored {
            let id=item["id"] as! String,similarity=item["similarity"] as! Double
            precondition(abs(similarity-expected[id]!)<=1e-12,"Score drifted for \(id): \(similarity) vs \(expected[id]!)")
        }
        let mismatch=try store.search(profile,query:Array(query.prefix(8)),entries:entries)
        precondition(mismatch.allSatisfy{$0["similarity"] == nil && $0["dimensions"] as? Int == 64},"Dimension mismatch must be reported, not scored")
        if legacy {
            var db:OpaquePointer?;sqlite3_open(folder.appendingPathComponent("vector-index.sqlite3").path,&db)
            // An older build replaces one row after migration: the next open merges it, with another backup.
            var changed=rows[5];changed["hash"]=String(repeating:"e",count:64);changed["profile"]=profile
            let text=String(decoding:try JSONSerialization.data(withJSONObject:changed),as:UTF8.self)
            precondition(sqlite3_exec(db,"INSERT OR REPLACE INTO vectors VALUES ('\(profile)', 'chunk-05', '\(text)')",nil,nil,nil)==SQLITE_OK)
            let reopened=NativeVectorStore(folder:folder),merged=try reopened.summary(profile)
            precondition(merged.count==rows.count && merged.first{$0["id"] as? String == "chunk-05"}?["hash"] as? String == String(repeating:"e",count:64),"Older build changes must be merged")
            let backups=try FileManager.default.contentsOfDirectory(atPath:folder.path).filter{$0.hasPrefix("vector-index.sqlite3.bak-")}.count;precondition(backups==2)
            _ = try NativeVectorStore(folder:folder).summary(profile)
            let after=try FileManager.default.contentsOfDirectory(atPath:folder.path).filter{$0.hasPrefix("vector-index.sqlite3.bak-")}.count;precondition(after==2,"Unchanged legacy table must not be migrated again")
            sqlite3_close(db)
        }
    }
}
