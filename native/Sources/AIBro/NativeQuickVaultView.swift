import AppKit
import SwiftUI

struct NativeQuickVaultView:View {
    @ObservedObject var store:NativeQuickVaultStore
    var onFocus:()->Void = {}
    var canFocus:()->Bool = {true}
    @Environment(\.colorScheme) private var colorScheme
    @State private var query=""
    @State private var selection=Set<String>()
    @State private var anchor:String?
    @State private var selecting=false
    @State private var deletion:NativeQuickVaultDeleteRequest?
    @State private var confirmDelete=false
    @State private var mounted=false
    @State private var focusEpoch=0
    @FocusState private var focusedRow:String?
    private var filtered:[NativeQuickVaultRow] {
        let term=query.trimmingCharacters(in:.whitespacesAndNewlines)
        return store.rows.filter{term.isEmpty || $0.service.localizedCaseInsensitiveContains(term) || $0.account.localizedCaseInsensitiveContains(term)}
    }
    private var editing:Binding<Bool>{Binding(get:{store.available && store.draft != nil},set:{_ in})}
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            HStack(spacing:10) {
                VStack(alignment:.leading,spacing:3) {
                    Text(nativeUI("账号密码", "Passwords")).font(.system(size:15,weight:.semibold))
                    Text(nativeUI("本机加密保存 · 不同步", "Encrypted locally · Not synced")).font(.system(size:11)).foregroundStyle(.secondary)
                }
                Spacer(minLength:8)
                Button {onFocus();store.beginNew()} label:{Label(nativeUI("添加", "Add"),systemImage:"plus")}
                    .disabled(!store.available || !store.loaded || store.hasEditor || store.busy)
            }
            if !store.available {
                Text(nativeUI("密码库暂不可用", "The vault is unavailable")).font(.system(size:12)).foregroundStyle(.secondary).frame(maxWidth:.infinity,maxHeight:.infinity)
            } else {
                HStack(spacing:8) {
                    Image(systemName:"magnifyingglass").foregroundStyle(.secondary)
                    TextField(nativeUI("搜索服务或账号", "Search services or accounts"),text:$query).textFieldStyle(.plain).onTapGesture{focusedRow=nil;onFocus()}
                    if !query.isEmpty{Button{query=""}label:{Image(systemName:"xmark.circle.fill")}.buttonStyle(.plain).accessibilityLabel(nativeUI("清除搜索", "Clear search"))}
                }.font(.system(size:12)).padding(.horizontal,10).frame(height:32).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:8))
                HStack(spacing:10) {
                    Text(selecting ? nativeUI("已选 \(selection.count)", "\(selection.count) selected"):nativeUI("\(filtered.count) 项", "\(filtered.count) entries")).foregroundStyle(.secondary)
                    Spacer(minLength:4)
                    if selecting {
                        Button(nativeUI("全选", "Select all")){selection=Set(filtered.map(\.id));if let id=filtered.first?.id{focus(id)}}.disabled(filtered.isEmpty)
                        Button(nativeUI("删除", "Delete"),role:.destructive){requestDelete()}.disabled(selection.isEmpty)
                        Button(nativeUI("完成", "Done")){selecting=false;selection=[];anchor=nil}
                    } else {
                        Button(nativeUI("选择", "Select")){selecting=true;if let id=filtered.first?.id{focus(id)}}.disabled(filtered.isEmpty)
                    }
                }.font(.system(size:11)).buttonStyle(.plain)
                if store.busy {ProgressView().controlSize(.small).frame(maxWidth:.infinity,alignment:.leading)}
                if let error=store.error {
                    HStack(alignment:.top,spacing:8) {
                        Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)
                        if !store.loaded{Button(nativeUI("重试读取", "Reload")){store.reload()}.font(.system(size:11))}
                        else if deletion != nil {
                            Button(nativeUI("重试删除", "Retry deletion")){confirmDelete=true}.font(.system(size:11)).disabled(store.busy)
                            Button(nativeUI("刷新", "Reload")){deletion=nil;store.reload()}.font(.system(size:11)).disabled(store.busy)
                        }
                    }
                }
                if filtered.isEmpty {
                    VStack(spacing:7){Image(systemName:"key").font(.system(size:24,weight:.light));Text(!store.loaded ? nativeUI("密码库尚未载入", "Vault not loaded") : (store.rows.isEmpty ? nativeUI("还没有保存账号", "No saved accounts"):nativeUI("没有匹配的账号", "No matching accounts"))).font(.system(size:13));Text(nativeUI("按服务或账号查找，密码不会参与搜索。", "Search by service or account. Passwords are not searched.")).font(.system(size:11))}.foregroundStyle(.secondary).frame(maxWidth:.infinity,maxHeight:.infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing:6) {ForEach(filtered){row in vaultRow(row)}}.padding(.vertical,2)
                    }
                }
                if let notice=store.notice {Text(notice).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)}
            }
        }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            .onAppear{mounted=true;store.setVisible(true)}
            .onDisappear{mounted=false;focusEpoch+=1;store.setVisible(false)}
            .onChange(of:filtered.map(\.id)){_,ids in selection.formIntersection(ids);if let anchor,!ids.contains(anchor){self.anchor=nil}}
            .onChange(of:store.available){_,value in if !value{focusEpoch+=1;focusedRow=nil;selection=[];anchor=nil;deletion=nil;confirmDelete=false;selecting=false}}
            .sheet(isPresented:editing){NativeQuickVaultEditor(store:store).preferredColorScheme(colorScheme)}
            .confirmationDialog(nativeUI("永久删除所选账号？", "Permanently delete selected entries?"),isPresented:$confirmDelete) {
                Button(nativeUI("删除", "Delete"),role:.destructive){if let deletion {Task{if await store.delete(deletion){selection=[];selecting=false;self.deletion=nil}}}}
                Button(nativeUI("取消", "Cancel"),role:.cancel){deletion=nil}
            } message:{Text(nativeUI("将删除 \(deletion?.rows.count ?? 0) 项。密码库不保留回收站，此操作不能撤销。", "Delete \(deletion?.rows.count ?? 0) entries. The vault has no trash; this cannot be undone."))}
            .onKeyPress(phases:.down){key in
                guard selecting,focusedRow != nil,store.available,!store.hasEditor else{return .ignored}
                if key.modifiers.contains(.command),key.characters.lowercased()=="a"{selection=Set(filtered.map(\.id));return .handled}
                if key.key == .escape{selection=[];selecting=false;return .handled}
                if key.key == .delete{requestDelete();return .handled}
                return .ignored
            }
    }
    private func vaultRow(_ row:NativeQuickVaultRow)->some View {
        HStack(spacing:12) {
            Button{choose(row)}label:{
                HStack(spacing:10) {
                    if selecting{Image(systemName:selection.contains(row.id) ? "checkmark.circle.fill":"circle").font(.system(size:16)).foregroundStyle(selection.contains(row.id) ? Color.accentColor:Color.secondary)}
                    VStack(alignment:.leading,spacing:4) {
                        Text(row.service).font(.system(size:12,weight:.medium)).lineLimit(1)
                        Text(row.account).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1)
                        Text(store.revealedID==row.id ? store.revealedPassword ?? "••••••••":"••••••••").font(.system(size:11,design:.monospaced)).lineLimit(2)
                            .accessibilityLabel(store.revealedID==row.id ? nativeUI("已显示密码", "Password revealed"):nativeUI("密码已隐藏", "Password hidden"))
                    }.frame(maxWidth:.infinity,alignment:.leading)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).focused($focusedRow,equals:row.id)
            if !selecting {
                Button {Task{await store.reveal(row)}}label:{Image(systemName:store.revealedID==row.id ? "eye.slash":"eye")}.help(nativeUI("显示或隐藏密码", "Show or hide password"))
                    .accessibilityLabel(nativeUI("显示或隐藏密码", "Show or hide password"))
                Menu {
                    Button(nativeUI("复制账号", "Copy account")){Task{await store.copy(row,field:.account)}}
                    Button(nativeUI("复制密码", "Copy password")){Task{await store.copy(row,field:.password)}}
                    Divider()
                    Button(nativeUI("编辑", "Edit")){onFocus();store.beginEdit(row)}
                    Button(nativeUI("删除", "Delete"),role:.destructive){deletion=store.deleteRequest(ids:[row.id]);confirmDelete=deletion != nil}
                }label:{Image(systemName:"ellipsis").frame(width:24,height:24)}.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel(nativeUI("账号操作", "Entry actions"))
                Button {Task{await store.copy(row,field:.password)}}label:{Image(systemName:"doc.on.doc")}.help(nativeUI("复制密码", "Copy password")).accessibilityLabel(nativeUI("复制密码", "Copy password"))
            }
        }.buttonStyle(.plain).disabled(store.busy).padding(12).background(.primary.opacity(selection.contains(row.id) ? 0.08:0.035),in:RoundedRectangle(cornerRadius:9))
    }
    private func choose(_ row:NativeQuickVaultRow){
        let shift=NSEvent.modifierFlags.contains(.shift)
        if selecting || shift {
            selecting=true
            if shift,let anchor,let first=filtered.firstIndex(where:{$0.id==anchor}),let last=filtered.firstIndex(where:{$0.id==row.id}) {selection.formUnion(filtered[min(first,last)...max(first,last)].map(\.id))}
            else {if !selection.insert(row.id).inserted{selection.remove(row.id)};anchor=row.id}
            focus(row.id)
        } else {onFocus();store.beginEdit(row)}
    }
    private func focus(_ id:String){
        onFocus();focusEpoch+=1;let epoch=focusEpoch;focusedRow=nil
        DispatchQueue.main.async{guard mounted,focusEpoch==epoch,store.available,canFocus(),filtered.contains(where:{$0.id==id}) else{return};focusedRow=id}
    }
    private func requestDelete(){deletion=store.deleteRequest(ids:selection);confirmDelete=deletion != nil}
}

private struct NativeQuickVaultEditor:View {
    @ObservedObject var store:NativeQuickVaultStore
    @FocusState private var serviceFocused:Bool
    private var draft:NativeQuickVaultDraft?{store.draft}
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            Text(draft?.expectedRevision==nil ? nativeUI("添加账号", "Add account"):nativeUI("编辑账号", "Edit account")).font(.system(size:17,weight:.semibold))
            Grid(alignment:.leading,horizontalSpacing:16,verticalSpacing:12) {
                GridRow{Text(nativeUI("服务", "Service"));TextField(nativeUI("例如校园门户", "For example, campus portal"),text:Binding(get:{draft?.service ?? ""},set:{store.updateDraft(service:$0)})).focused($serviceFocused)}
                GridRow{Text(nativeUI("账号", "Account"));TextField(nativeUI("用户名或邮箱", "Username or email"),text:Binding(get:{draft?.account ?? ""},set:{store.updateDraft(account:$0)}))}
                GridRow{Text(nativeUI("密码", "Password"));SecureField(draft?.expectedRevision==nil ? nativeUI("输入密码或 Token", "Enter a password or token"):nativeUI("留空保留已保存密码", "Leave blank to keep saved password"),text:Binding(get:{draft?.password ?? ""},set:{store.updateDraft(password:$0)}))}
            }.textFieldStyle(.roundedBorder).font(.system(size:12))
            Text(nativeUI("仅保存在此 Mac，不会用于 AI 对话或工作区同步。", "Stored only on this Mac. Not used in AI conversations or workspace sync.")).font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            if let error=store.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack{Spacer();Button(nativeUI("取消", "Cancel")){store.cancelDraft()}.keyboardShortcut(.cancelAction);Button(nativeUI("保存", "Save")){Task{await store.save()}}.keyboardShortcut(.defaultAction).disabled(draft?.valid != true)}
        }.padding(22).frame(width:410).disabled(!store.available || store.busy).interactiveDismissDisabled()
            .onAppear{DispatchQueue.main.async{if store.available{serviceFocused=true}}}
    }
}
