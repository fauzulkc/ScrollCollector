//go:build windows
package main

import (
	"runtime"
	"sync"
	"github.com/go-ole/go-ole"
	"github.com/jchv/go-webview2"
)

var (
	dashboardWindow webview2.WebView
	windowLock      sync.Mutex
)

func showDashboardUI() {
	windowLock.Lock()
	defer windowLock.Unlock()

	// If already open, close it to bring up a fresh focused window
	if dashboardWindow != nil {
		dashboardWindow.Destroy()
		dashboardWindow = nil
	}

	go func() {
		// IMPORTANT: Pin the goroutine to the current OS thread.
		// This guarantees that the Win32 window message loop operates on a single thread apartment,
		// preventing the window from becoming unresponsive or hanging.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		// Initialize COM for this thread
		ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED)
		defer ole.CoUninitialize()

		w := webview2.NewWithOptions(webview2.WebViewOptions{
			WindowOptions: webview2.WindowOptions{
				Title:  "ScrollCollector Dashboard",
				Width:  980,
				Height: 700,
				Center: true,
			},
		})
		if w == nil {
			return
		}

		windowLock.Lock()
		dashboardWindow = w
		windowLock.Unlock()

		// Navigate native webview to local companion server endpoint
		w.Navigate("http://127.0.0.1:18181/")
		w.Run()

		windowLock.Lock()
		dashboardWindow = nil
		windowLock.Unlock()
	}()
}
