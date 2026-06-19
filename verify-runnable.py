#!/usr/bin/env python3
"""Independently verify runnable coding questions in the assessment banks:
for each question with a harness, compile/run `solution + harness` and confirm
every embedded test case passes; also confirm the `starter + harness` builds.
C++ uses clang++ (falls back to g++); Python uses python3.

    python3 verify-runnable.py [site/assessments/foo.json ...]   # default: all
"""
import json, re, subprocess, tempfile, os, sys, glob, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
CXX = shutil.which("clang++") or shutil.which("g++")


def code(md):
    m = re.search(r"```[a-zA-Z0-9+]*\n([\s\S]*?)```", md or "")
    return m.group(1) if m else (md or "")


def build_run(lang, src, run=True):
    d = tempfile.mkdtemp()
    try:
        if lang == "python":
            f = os.path.join(d, "q.py"); open(f, "w").write(src)
            if not run:
                c = subprocess.run([sys.executable, "-c", "compile(open(%r).read(),'q','exec')" % f], capture_output=True, text=True, timeout=20)
                return ("BUILDS", "") if c.returncode == 0 else ("BUILD_FAIL", c.stderr[:300])
            r = subprocess.run([sys.executable, f], capture_output=True, text=True, timeout=15)
            out = r.stdout
        else:
            f = os.path.join(d, "q.cpp"); b = os.path.join(d, "q"); open(f, "w").write(src)
            c = subprocess.run([CXX, "-std=c++20", "-O2", "-pthread", "-o", b, f], capture_output=True, text=True, timeout=60)
            if c.returncode != 0:
                return ("BUILD_FAIL", c.stderr[:300])
            if not run:
                return ("BUILDS", "")
            r = subprocess.run([b], capture_output=True, text=True, timeout=15)
            out = r.stdout
        cases = [l for l in out.split("\n") if l.startswith("__CASE__|")]
        p = sum(1 for l in cases if l.split("|")[2] == "PASS")
        return ("RUN", (p, len(cases)))
    except subprocess.TimeoutExpired:
        return ("TIMEOUT", "")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def verify(path, default_lang):
    bank = json.load(open(path))
    total = ok = starterbad = 0; problems = []
    for slug, mod in bank.get("modules", {}).items():
        for c in mod.get("coding", []):
            if "harness" not in c:
                continue
            total += 1
            lang = c.get("lang", default_lang)
            H = "\n" + c["harness"]
            st, info = build_run(lang, code(c.get("solution", "")) + H, run=True)
            if st == "RUN" and info[1] > 0 and info[0] == info[1]:
                ok += 1
            else:
                problems.append(f"{slug}/{c.get('topic')}: solution {st} {info}")
            sst, _ = build_run(lang, c.get("starter", "") + H, run=False)
            if sst == "BUILD_FAIL":
                starterbad += 1; problems.append(f"{slug}/{c.get('topic')}: STARTER build fail")
    return total, ok, starterbad, problems


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "site", "assessments", "*.json")))
    for p in paths:
        rid = os.path.splitext(os.path.basename(p))[0]
        dl = "python" if rid == "python" else "cpp"
        total, ok, sb, probs = verify(p, dl)
        print(f"{rid}: runnable {total} | solution-passes-all {ok} | starter-build-fails {sb}")
        for pr in probs:
            print("   -", pr)
