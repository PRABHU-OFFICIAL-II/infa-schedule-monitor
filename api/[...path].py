import sys
import os

# Make the repo root importable so `src` package resolves correctly
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.main import app  # Vercel detects this as an ASGI app natively — no Mangum needed
