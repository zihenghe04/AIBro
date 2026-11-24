import UserNotifications

/// The three notification sounds, distinct by contour: reminders (agenda,
/// scheduler, the morning brief), approvals (a run waiting on you or paused)
/// and finished background runs. Files are bundled from native/Resources/Sounds;
/// a missing file falls back to the system sound.
enum NotificationSounds {
    static let preferenceKey="AIBroNotificationSoundsOn"
    /// Notification sounds are on unless the user turned them off in Settings > Notifications.
    static var enabled:Bool {
        get {UserDefaults.standard.object(forKey:preferenceKey) as? Bool ?? true}
        set {UserDefaults.standard.set(newValue,forKey:preferenceKey)}
    }
    static var reminder:UNNotificationSound? {named("aibro-reminder")}
    static var approval:UNNotificationSound? {named("aibro-approval")}
    static var done:UNNotificationSound? {named("aibro-done")}
    private static func named(_ name:String)->UNNotificationSound? {
        if !enabled {return nil}
        return Bundle.main.url(forResource:name,withExtension:"caf") == nil ? .default:UNNotificationSound(named:UNNotificationSoundName(name+".caf"))
    }
}
