#!/usr/bin/env python3
"""Rebalance MCQ correct-answer positions in the assessment banks so the right
answer isn't always the same letter (which would make quizzes gameable).

For each MCQ, rotates its options so the correct answer lands at a target index
that cycles 0,1,2,3 across the file. Correctness-preserving and idempotent
(running it again is a no-op). Run with no args to process all banks.

    python3 rebalance.py [site/assessments/foo.json ...]
"""
import json
import sys
import glob
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def rebalance(path):
    bank = json.load(open(path))
    c = 0
    dist = {0: 0, 1: 0, 2: 0, 3: 0}
    for mod in bank.get("modules", {}).values():
        for q in mod.get("mcqs", []):
            opts, a = q.get("options"), q.get("answer")
            if not isinstance(opts, list) or len(opts) != 4 or not isinstance(a, int) or not (0 <= a <= 3):
                continue
            target = c % 4
            s = (a - target) % 4
            q["options"] = opts[s:] + opts[:s]      # rotate left by s
            q["answer"] = target                    # correct option now at target
            assert q["options"][target] == opts[a]  # correctness preserved
            dist[target] += 1
            c += 1
    json.dump(bank, open(path, "w"), indent=2, ensure_ascii=False)
    return c, dist


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "site", "assessments", "*.json")))
    for p in paths:
        n, dist = rebalance(p)
        print(f"{os.path.relpath(p, ROOT)}: {n} MCQs -> {dist}")
