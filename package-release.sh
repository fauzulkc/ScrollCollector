#!/bin/bash

# ScrollCollector Release Packaging Script
# This script builds the installers and packages them into shareable .zip files
# for Friends & Family distribution.

echo "===================================================="
echo "  ScrollCollector Release Packager"
echo "===================================================="
echo

# 1. Run the build script
echo "[+] Running build-installer.sh..."
./build-installer.sh

if [ $? -ne 0 ]; then
    echo "[!] Build failed. Aborting release packaging."
    exit 1
fi

# 2. Create releases directory
mkdir -p releases
rm -rf releases/*

# 3. Package Windows Release
if [ -f "dist/ScrollCollectorInstaller.exe" ]; then
    echo "[+] Packaging Windows Release..."
    
    # We zip the .exe because many email clients and chat apps block direct .exe transfers
    zip -j releases/ScrollCollector-Windows-v2.zip dist/ScrollCollectorInstaller.exe
    
    if [ $? -eq 0 ]; then
        echo "[+] SUCCESS: Created releases/ScrollCollector-Windows-v2.zip"
    else
        echo "[!] Failed to create Windows zip."
    fi
else
    echo "[-] dist/ScrollCollectorInstaller.exe not found, skipping Windows package."
fi

# 4. Package macOS Release (if built)
if [ -f "dist/ScrollCollectorInstaller" ]; then
    echo "[+] Packaging macOS Release..."
    
    zip -j releases/ScrollCollector-macOS-v2.zip dist/ScrollCollectorInstaller
    
    if [ $? -eq 0 ]; then
        echo "[+] SUCCESS: Created releases/ScrollCollector-macOS-v2.zip"
    else
        echo "[!] Failed to create macOS zip."
    fi
fi

echo
echo "===================================================="
echo "  Packaging Complete! Check the /releases folder."
echo "===================================================="
