#!/usr/bin/env python3
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(os.environ.get('PORT', 8080))
os.execv(sys.executable, [sys.executable, '-m', 'http.server', str(port)])
