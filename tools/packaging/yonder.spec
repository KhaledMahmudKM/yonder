# PyInstaller recipe for the Yonder desktop app: one Yonder.exe on Windows (from DockerLab's).
#   pip install -r backend/requirements.txt pyinstaller
#   pyinstaller --noconfirm --distpath dist --workpath build tools/packaging/yonder.spec
# GitHub builds it on Windows for every release (.github/workflows/release.yml).
# It needs the built web interface in backend/static (cd frontend && npm run build).
import os
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
B = os.path.join(ROOT, "backend")

datas = [(os.path.join(B, "static"), os.path.join("backend", "static"))]
for f in ("VERSION", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"):
    datas.append((os.path.join(ROOT, f), "."))

# Yonder's own modules; uvicorn picks its parts at run time
modules = [m[:-3] for m in os.listdir(B) if m.endswith(".py") and m != "main.py"]
hidden = modules + collect_submodules("uvicorn") + ["websockets", "paramiko"]

a = Analysis([os.path.join(B, "main.py")], pathex=[B], datas=datas, hiddenimports=hidden,
             excludes=["tkinter", "matplotlib", "numpy", "PIL"])
pyz = PYZ(a.pure)
icon = os.path.join(SPECPATH, "yonder.ico")
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [],
          name="Yonder", console=True,           # the window shows what Yonder does; Ctrl+C stops it
          icon=icon if os.path.exists(icon) else None, upx=False)
