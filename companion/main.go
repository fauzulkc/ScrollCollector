package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/getlantern/systray"
)

//go:embed dashboard.html
var dashboardHTML []byte

// Database structures
var (
	stateLock     sync.Mutex
	stateJSON     map[string]interface{}
	lastUpdated   int64
	dbPath        string
	serverRunning bool
)

func main() {
	// Initialize paths and database
	dbPath = getDBPath()
	loadDatabase()

	// Start system tray in the main thread (required by macOS/Windows GUI loops)
	systray.Run(onReady, onExit)
}

func getDBPath() string {
	home, _ := os.UserHomeDir()
	var appDir string
	if runtime.GOOS == "windows" {
		appDir = filepath.Join(os.Getenv("APPDATA"), "ScrollCollector")
	} else {
		appDir = filepath.Join(home, "Library", "Application Support", "ScrollCollector")
	}
	_ = os.MkdirAll(appDir, 0755)
	return filepath.Join(appDir, "db.json")
}

func loadDatabase() {
	stateLock.Lock()
	defer stateLock.Unlock()

	lastUpdated = time.Now().UnixNano() / int64(time.Millisecond)

	// Check if DB exists
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		seedDefaultDatabase()
		return
	}

	data, err := os.ReadFile(dbPath)
	if err != nil || len(data) == 0 {
		seedDefaultDatabase()
		return
	}

	err = json.Unmarshal(data, &stateJSON)
	if err != nil {
		seedDefaultDatabase()
	}
}

func seedDefaultDatabase() {
	// Seed with exactly the default configuration keys
	defaultState := `{
		"configuration": {
			"trackedTags": [
				{"id": "t1",  "label": "Tech",                 "isEnabled": true, "prompt": "Identify posts related to software, technology, programming, developer tools, hardware, or computing."},
				{"id": "t2",  "label": "Finance",               "isEnabled": true, "prompt": "Identify posts related to finance, economy, markets, stocks, cryptocurrencies, investing, or banking."},
				{"id": "t3",  "label": "AI & Machine Learning",  "isEnabled": true, "prompt": "Identify posts related to artificial intelligence, machine learning, LLMs, deep learning, or neural networks."},
				{"id": "t4",  "label": "Health & Wellness",      "isEnabled": true, "prompt": "Identify posts related to health, fitness, nutrition, medicine, wellness, or healthy living."},
				{"id": "t5",  "label": "Politics & Society",     "isEnabled": true, "prompt": "Identify posts related to elections, government policy, politics, laws, or societal issues."},
				{"id": "t6",  "label": "Entertainment",          "isEnabled": true, "prompt": "Identify posts related to movies, television, music, gaming, celebrity culture, or comedy."},
				{"id": "t7",  "label": "Sports",                 "isEnabled": true, "prompt": "Identify posts related to sports, games, leagues, players, tournaments, or championships."},
				{"id": "t8",  "label": "Science",                "isEnabled": true, "prompt": "Identify posts related to physics, chemistry, biology, astronomy, research, or scientific discoveries."},
				{"id": "t9",  "label": "Education",              "isEnabled": true, "prompt": "Identify posts related to universities, schools, courses, study tips, tutorials, or academic learning."},
				{"id": "t10", "label": "Business & Startups",    "isEnabled": true, "prompt": "Identify posts related to businesses, startup companies, entrepreneurship, VC funding, or marketing."},
				{"id": "t_ads", "label": "Ads",                  "isEnabled": true, "prompt": "Identify advertising, sponsored posts, product sales, or promotional offers."}
			],
			"sites": [
				{"id": "s1", "domain": "facebook.com", "isEnabled": true, "isCustom": false},
				{"id": "s2", "domain": "linkedin.com", "isEnabled": true, "isCustom": false},
				{"id": "s4", "domain": "x.com", "isEnabled": true, "isCustom": false},
				{"id": "s5", "domain": "instagram.com", "isEnabled": true, "isCustom": false},
				{"id": "s6", "domain": "youtube.com", "isEnabled": true, "isCustom": false},
				{"id": "s7", "domain": "medium.com", "isEnabled": true, "isCustom": false}
			],
			"ignoredKeywords": [],
			"isTrackingPaused": false
		},
		"metrics": {"counts": {}},
		"stack": [],
		"telemetry": {"totalProcessed": 0, "classifiedCount": 0, "unclassifiedCount": 0, "sessionStart": 0, "lastProcessed": null},
		"inFlightCount": 0
	}`
	
	_ = json.Unmarshal([]byte(defaultState), &stateJSON)
	// Write immediately
	saveDatabaseInternal()
}

func saveDatabaseInternal() {
	data, _ := json.MarshalIndent(stateJSON, "", "  ")
	_ = os.WriteFile(dbPath, data, 0644)
	lastUpdated = time.Now().UnixNano() / int64(time.Millisecond)
}

func saveDatabase() {
	stateLock.Lock()
	defer stateLock.Unlock()
	saveDatabaseInternal()
}

// ---------------------------------------------------------------------------
// HTTP Server & APIs
// ---------------------------------------------------------------------------

func startHTTPServer() {
	if serverRunning {
		return
	}
	serverRunning = true

	mux := http.NewServeMux()
	
	// Dashboard SPA
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write(dashboardHTML)
	})

	// GET /api/status
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		
		stateLock.Lock()
		isPaused := false
		if config, ok := stateJSON["configuration"].(map[string]interface{}); ok {
			if pausedVal, exists := config["isTrackingPaused"].(bool); exists {
				isPaused = pausedVal
			}
		}
		stateLock.Unlock()

		response := map[string]interface{}{
			"isTrackingPaused": isPaused,
			"lastUpdated":      lastUpdated,
		}
		json.NewEncoder(w).Encode(response)
	})

	// GET & POST /api/state
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		// Enable CORS
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method == http.MethodPost {
			// Merge partial updates
			var update map[string]interface{}
			err := json.NewDecoder(r.Body).Decode(&update)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			stateLock.Lock()
			for k, v := range update {
				stateJSON[k] = v
			}
			saveDatabaseInternal()
			stateLock.Unlock()
			
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]bool{"success": true})
			return
		}

		// GET returns full database state
		stateLock.Lock()
		json.NewEncoder(w).Encode(stateJSON)
		stateLock.Unlock()
	})

	// POST /api/toggle-pause
	mux.HandleFunc("/api/toggle-pause", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		stateLock.Lock()
		if config, ok := stateJSON["configuration"].(map[string]interface{}); ok {
			isPaused := false
			if pausedVal, exists := config["isTrackingPaused"].(bool); exists {
				isPaused = pausedVal
			}
			config["isTrackingPaused"] = !isPaused
			saveDatabaseInternal()
		}
		stateLock.Unlock()

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
	})

	// Start listener strictly on loopback (127.0.0.1) to avoid firewall triggers
	go func() {
		err := http.ListenAndServe("127.0.0.1:18181", mux)
		if err != nil {
			fmt.Printf("Server failed: %v\n", err)
		}
	}()
}

// ---------------------------------------------------------------------------
// System Tray Operations
// ---------------------------------------------------------------------------

func onReady() {
	systray.SetIcon(trayIcon)
	systray.SetTitle("ScrollCollector")
	systray.SetTooltip("ScrollCollector Companion")

	// Menu options
	mOpen := systray.AddMenuItem("Open Dashboard", "Open ScrollCollector web console")
	mPause := systray.AddMenuItem("Pause Collection", "Toggle scanning pause status")
	mExport := systray.AddMenuItem("Export HTML Diary", "Export feed items as styled offline document")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Exit companion app")

	// Start sync API
	startHTTPServer()

	// Menu Event Loop
	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				openDashboard()
			case <-mPause.ClickedCh:
				togglePause()
				// Update pause menu label
				stateLock.Lock()
				isPaused := false
				if config, ok := stateJSON["configuration"].(map[string]interface{}); ok {
					if p, ok2 := config["isTrackingPaused"].(bool); ok2 {
						isPaused = p
					}
				}
				stateLock.Unlock()
				
				if isPaused {
					mPause.SetTitle("Resume Collection")
				} else {
					mPause.SetTitle("Pause Collection")
				}
			case <-mExport.ClickedCh:
				exportHtmlDiary()
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	// Flush any final state mutations
	saveDatabase()
}

func openDashboard() {
	showDashboardUI()
}

func togglePause() {
	stateLock.Lock()
	defer stateLock.Unlock()
	if config, ok := stateJSON["configuration"].(map[string]interface{}); ok {
		isPaused := false
		if p, ok2 := config["isTrackingPaused"].(bool); ok2 {
			isPaused = p
		}
		config["isTrackingPaused"] = !isPaused
		saveDatabaseInternal()
	}
}

func exportHtmlDiary() {
	home, _ := os.UserHomeDir()
	var downloadDir string
	if runtime.GOOS == "windows" {
		downloadDir = filepath.Join(home, "Downloads")
	} else {
		downloadDir = filepath.Join(home, "Downloads")
	}
	
	exportPath := filepath.Join(downloadDir, "ScrollCollectorDiary.html")
	
	// Create simplified HTML Diary document
	stateLock.Lock()
	stackBytes, _ := json.Marshal(stateJSON["stack"])
	stateLock.Unlock()

	diaryHTML := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ScrollCollector Feed Diary</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: #f1f5f9; padding: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .header { display: flex; justify-content: space-between; color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .body { font-size: 1rem; line-height: 1.5; }
    h1 { text-align: center; }
  </style>
</head>
<body>
  <h1>ScrollCollector Feed Diary</h1>
  <div id="cards"></div>
  <script>
    const stack = %s;
    const cardsDiv = document.getElementById("cards");
    if (!stack || stack.length === 0) {
      cardsDiv.innerHTML = "<p style='text-align:center;'>No items exported.</p>";
    } else {
      stack.forEach(item => {
        const card = document.createElement("div");
        card.className = "card";
        const dateStr = new Date(item.timestamp).toLocaleString();
        card.innerHTML = " \
          <div class='header'> \
            <span>" + item.sourcePlatform + " &bull; " + item.assignedTag + "</span> \
            <span>" + dateStr + "</span> \
          </div> \
          <div class='body'>" + item.textSnippet + "</div>";
        cardsDiv.appendChild(card);
      });
    }
  </script>
</body>
</html>`, string(stackBytes))

	_ = os.WriteFile(exportPath, []byte(diaryHTML), 0644)

	// Launch exported diary
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "start", exportPath)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	} else {
		cmd = exec.Command("open", exportPath)
	}
	_ = cmd.Start()
}
