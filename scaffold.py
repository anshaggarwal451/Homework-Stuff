#!/usr/bin/env python3
"""Read the base curriculum.json, enrich it with slugs + content paths,
write site/curriculum.json, and create the content/ tree with placeholders.
Idempotent: never overwrites a lesson file that already has real content."""
import json, re, os, pathlib

ROOT = pathlib.Path(__file__).parent
SITE = ROOT / "site"
DIFF = {"E": "Easy", "M": "Medium", "H": "Hard"}
PLACEHOLDER = "<!-- PLACEHOLDER -->"


# Learning-flow DAG per roadmap: node positions (col = left→right layer, row = vertical)
# and prerequisite edges, derived from the bequant.dev roadmap screenshots.
GRAPHS = {
    "cppbasics": {
        "nodes": {
            "syntax-and-fundamentals": [0, 1], "pointers": [1, 1],
            "templates": [2, 0], "object-oriented-programming": [2, 2],
            "stl-containers-and-algorithms": [3, 0], "advanced-features": [4, 1],
        },
        "edges": [
            ["syntax-and-fundamentals", "pointers"], ["pointers", "templates"],
            ["pointers", "object-oriented-programming"], ["templates", "stl-containers-and-algorithms"],
            ["stl-containers-and-algorithms", "advanced-features"], ["object-oriented-programming", "advanced-features"],
        ],
    },
    "csfundamentals": {
        "nodes": {
            "cpu-architecture-basics": [0, 1], "cpu-architecture-advanced": [1, 2.2],
            "operating-systems": [1, 0.6], "networking": [2, 0], "programming-principles": [2, 2],
            "ipc": [3, 0], "userspace-networking": [4, 0],
        },
        "edges": [
            ["cpu-architecture-basics", "operating-systems"], ["cpu-architecture-basics", "cpu-architecture-advanced"],
            ["operating-systems", "networking"], ["operating-systems", "programming-principles"],
            ["networking", "ipc"], ["ipc", "userspace-networking"],
        ],
    },
    "lowlatency": {
        "nodes": {
            "cpp-fundamentals": [0, 1.5], "multithreading": [1, 0], "stl-and-algorithms": [1, 1.5],
            "templates-basics": [1, 3], "queues": [2, 1.5], "multithreaded-queues": [3, 0],
            "system-design-basics": [3, 1.5], "templates-advanced": [3, 3], "system-design-advanced": [4, 1.5],
        },
        "edges": [
            ["cpp-fundamentals", "multithreading"], ["cpp-fundamentals", "stl-and-algorithms"],
            ["cpp-fundamentals", "templates-basics"], ["stl-and-algorithms", "queues"],
            ["multithreading", "multithreaded-queues"], ["queues", "multithreaded-queues"],
            ["queues", "system-design-basics"], ["system-design-basics", "system-design-advanced"],
            ["templates-basics", "templates-advanced"],
        ],
    },
    "python": {
        "nodes": {
            "foundations": [0, 1], "numpy-essentials": [1, 1], "pandas": [2, 0],
            "analytics-and-ml-libraries": [2, 1], "vectorization-and-performance": [2, 2],
        },
        "edges": [
            ["foundations", "numpy-essentials"], ["numpy-essentials", "pandas"],
            ["numpy-essentials", "analytics-and-ml-libraries"], ["numpy-essentials", "vectorization-and-performance"],
        ],
    },
}


def slug(s: str) -> str:
    s = s.lower()
    s = s.replace("c++", "cpp").replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def uniq(base, seen):
    s = base or "x"
    i = 2
    while s in seen:
        s = f"{base}-{i}"
        i += 1
    seen.add(s)
    return s


base = json.loads((ROOT / "curriculum.json").read_text())
out_roadmaps = []
total_topics = 0
placeholders_made = 0

for rm in base["roadmaps"]:
    rid = rm["id"]
    mod_seen = set()
    modules = []
    for node in rm["nodes"]:
        mslug = uniq(slug(node["title"]), mod_seen)
        topic_seen = set()
        topics = []
        for title, d in node["topics"]:
            tslug = uniq(slug(title), topic_seen)
            cpath = f"content/{rid}/{mslug}/{tslug}.md"
            topics.append({
                "slug": tslug,
                "title": title,
                "difficulty": DIFF[d],
                "contentPath": cpath,
            })
            total_topics += 1
            # create placeholder file if missing
            fp = SITE / cpath
            fp.parent.mkdir(parents=True, exist_ok=True)
            if not fp.exists():
                fp.write_text(
                    f"{PLACEHOLDER}\n# {title}\n\n"
                    "_This lesson hasn't been written yet._\n"
                )
                placeholders_made += 1
        modules.append({
            "slug": mslug,
            "title": node["title"],
            **({"inferred": True} if node.get("inferred") else {}),
            "topics": topics,
        })
    out_roadmaps.append({
        "id": rid,
        "title": rm["title"],
        "estimate": rm.get("estimate", ""),
        "topicCount": rm.get("topic_count", sum(len(m["topics"]) for m in modules)),
        "graph": GRAPHS.get(rid),
        "modules": modules,
    })

enriched = {
    "title": "BeQuant — local study build",
    "tagline": "Quant developer prep · reconstructed locally",
    "placeholderMarker": PLACEHOLDER,
    "roadmaps": out_roadmaps,
}
(SITE / "curriculum.json").write_text(json.dumps(enriched, indent=2))
print(f"roadmaps={len(out_roadmaps)} topics={total_topics} placeholders_created={placeholders_made}")
print("wrote", SITE / "curriculum.json")
