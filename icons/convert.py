from PIL import Image
import os

png_path = "icons/icon-128.png"
ico_path = "icons/icon.ico"

if os.path.exists(png_path):
    img = Image.open(png_path)
    img.save(ico_path, format="ICO", sizes=[(16,16), (32,32), (48,48), (128,128)])
    print("SUCCESS: Created icons/icon.ico")
else:
    print("ERROR: PNG icon not found")
