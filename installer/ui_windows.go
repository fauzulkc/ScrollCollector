//go:build windows
package main

import (
	"encoding/json"
	"syscall"
	"github.com/jchv/go-webview2"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procGetWindowLong    = user32.NewProc("GetWindowLongW")
	procSetWindowLong    = user32.NewProc("SetWindowLongW")
	procSetWindowPos     = user32.NewProc("SetWindowPos")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
)

const (
	GWL_STYLE = -16

	WS_CAPTION     = 0x00C00000 // Title bar
	WS_THICKFRAME  = 0x00040000 // Resizing frame
	WS_SYSMENU     = 0x00080000 // System menu
	WS_MINIMIZEBOX = 0x00020000 // Minimize button
	WS_MAXIMIZEBOX = 0x00010000 // Maximize button

	SWP_FRAMECHANGED = 0x0020
	SWP_NOMOVE       = 0x0002
	SWP_NOSIZE       = 0x0001
	SWP_NOZORDER     = 0x0004

	SM_CXSCREEN = 0
	SM_CYSCREEN = 1
)

func makeFrameless(hwnd uintptr) {
	// Retrieve window style flags
	gwlStyle := int32(GWL_STYLE)
	style, _, _ := procGetWindowLong.Call(hwnd, uintptr(gwlStyle))
	if style == 0 {
		return
	}

	// Remove caption (title bar), system menu, minimize/maximize buttons
	// We do NOT remove WS_THICKFRAME so it remains resizable by dragging borders!
	style &^= WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX

	// Apply updated style
	procSetWindowLong.Call(hwnd, uintptr(gwlStyle), style)

	// Apply frame changes
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, SWP_FRAMECHANGED|SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER)
}

func launchInstallerUI() {
	// Calculate 60% and 25% of screen size dynamically
	screenWidth, _, _ := procGetSystemMetrics.Call(uintptr(SM_CXSCREEN))
	screenHeight, _, _ := procGetSystemMetrics.Call(uintptr(SM_CYSCREEN))

	if screenWidth == 0 || screenHeight == 0 {
		screenWidth = 1920
		screenHeight = 1080
	}

	startWidth := int(float64(screenWidth) * 0.6)
	startHeight := int(float64(screenHeight) * 0.6)

	minWidth := int(float64(screenWidth) * 0.25)
	minHeight := int(float64(screenHeight) * 0.25)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		WindowOptions: webview2.WindowOptions{
			Title:  "ScrollCollector Installer",
			Width:  uint(startWidth),
			Height: uint(startHeight),
			Center: true,
		},
	})
	
	if w == nil {
		return
	}
	defer w.Destroy()

	// Set start size and make it resizable
	w.SetSize(startWidth, startHeight, webview2.HintNone)

	// Apply 25% minimum bounds
	w.SetSize(minWidth, minHeight, webview2.HintMin)

	// Convert native Window unsafe.Pointer to uintptr and strip chrome window borders
	makeFrameless(uintptr(w.Window()))

	// 1. Bind JavaScript function for browser detection
	w.Bind("detectBrowsers", func() string {
		browsers := map[string]bool{
			"chrome": hasChrome,
		}
		b, _ := json.Marshal(browsers)
		return string(b)
	})

	// 2. Bind JavaScript function for installer triggers
	w.Bind("installScrollCollector", func() string {
		err := runInstallSequence()
		if err != nil {
			res, _ := json.Marshal(map[string]interface{}{
				"success": false,
				"error":   err.Error(),
			})
			return string(res)
		}
		res, _ := json.Marshal(map[string]interface{}{
			"success": true,
		})
		return string(res)
	})

	// 3. Bind JavaScript function for shutdown
	w.Bind("exitInstaller", func() {
		w.Destroy()
	})

	// 4. Load setup guide HTML natively
	w.SetHtml(string(installGuideHTML))

	// 5. Run message loop
	w.Run()
}
