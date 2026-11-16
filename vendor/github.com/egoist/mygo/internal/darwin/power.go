//go:build darwin

package darwin

import "time"

type power struct{ b *Backend }

// powerEvents maps the notifications the app delegate observes to power
// events.
var powerEvents = map[string]string{
	"NSWorkspaceWillSleepNotification": "suspend",
	"NSWorkspaceDidWakeNotification":   "resume",
	"com.apple.screenIsLocked":         "lock-screen",
	"com.apple.screenIsUnlocked":       "unlock-screen",
}

func (p power) Watch() {
	withPool(func() {
		observe := func(center id, name string) {
			send(center, "addObserver:selector:name:object:", uintptr(p.b.delegate), uintptr(sel("mygoPowerNotification:")), uintptr(nsString(name)), 0)
		}
		workspace := send(send(class("NSWorkspace"), "sharedWorkspace"), "notificationCenter")
		observe(workspace, "NSWorkspaceWillSleepNotification")
		observe(workspace, "NSWorkspaceDidWakeNotification")
		// Screen locking is only announced to other processes.
		distributed := send(class("NSDistributedNotificationCenter"), "defaultCenter")
		observe(distributed, "com.apple.screenIsLocked")
		observe(distributed, "com.apple.screenIsUnlocked")
	})
}

// Options of NSProcessInfo's activities.
const (
	activityIdleSystemSleepDisabled  = 1 << 20
	activityIdleDisplaySleepDisabled = 1 << 40
	// activityUserInitiated is NSActivityUserInitiated, which keeps App
	// Nap off and the Mac from sleeping when idle: the second it leaves
	// out (NSActivityUserInitiatedAllowingIdleSystemSleep).
	activityUserInitiated = 0x00FFFFFF | activityIdleSystemSleepDisabled
)

func (p power) KeepAwake(display bool, reason string) func() {
	opts := uint64(activityIdleSystemSleepDisabled)
	if display {
		opts |= activityIdleDisplaySleepDisabled
	}
	return beginActivity(opts, reason)
}

// KeepRunning holds NSActivityUserInitiatedAllowingIdleSystemSleep, an
// activity of the user's that keeps App Nap off while the Mac still sleeps
// when idle: the system does not suppress the app (proc_pidinfo's
// PROC_FLAG_SUPPRESSED) once none of its windows shows. KeepAwake's
// activity keeps App Nap off too, but the Mac awake as well, and shows in
// pmset -g assertions, which this one does not.
func (p power) KeepRunning(reason string) func() {
	return beginActivity(activityUserInitiated&^activityIdleSystemSleepDisabled, reason)
}

// beginActivity begins an activity of NSProcessInfo with the options, which
// the function it returns ends.
func beginActivity(opts uint64, reason string) func() {
	var token id
	withPool(func() {
		info := send(class("NSProcessInfo"), "processInfo")
		token = retain(send(info, "beginActivityWithOptions:reason:", uintptr(opts), uintptr(nsString(reason))))
	})
	return func() {
		send(send(class("NSProcessInfo"), "processInfo"), "endActivity:", uintptr(token))
		release(token)
	}
}

func (p power) OnBattery() bool {
	if iopsCopyPowerSourcesInfo == nil {
		return false
	}
	info := iopsCopyPowerSourcesInfo()
	if info == 0 {
		return false
	}
	defer cfRelease(info)
	return goString(iopsGetProvidingPowerSourceType(info)) == "Battery Power"
}

func (p power) IdleTime() time.Duration {
	const combinedSessionState, anyInputEvent = 0, ^uint32(0)
	return time.Duration(cgEventSourceSecondsSinceLastType(combinedSessionState, anyInputEvent) * float64(time.Second))
}
