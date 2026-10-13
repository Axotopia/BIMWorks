# BIMWorks

> **Native-IFC Architectural BIM Authoring Application — AI-First by Design**  
> *Compliant with GLM Improved Master Specification v2.1*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![IFC Version: IFC4 ADD2](https://img.shields.io/badge/IFC-IFC4%20ADD2-green.svg)](https://standards.buildingsmart.org/)
[![Units: Decimal Feet](https://img.shields.io/badge/Internal%20Units-Decimal%20Feet-orange.svg)]()
[![Frontend: React 19 + Three.js](https://img.shields.io/badge/Frontend-React%2019%20%7C%20Three.js-61dafb.svg)]()
[![Backend: FastAPI + IfcOpenShell](https://img.shields.io/badge/Backend-FastAPI%20%7C%20IfcOpenShell-009688.svg)]()

---

## 1. Overview

**BIMWorks** is an open-source, native-IFC architectural Building Information Modeling (BIM) desktop authoring platform and 2D Construction Document (CD) generator.

BIMWorks is designed from the ground up to clone the core mechanical precision of Autodesk Revit® — elements with parameters, transactional change engines, datum-driven levels/grids, host-based wall voids, 2D plan corner joins, view range slicing, and ARCH D sheet compilation — while using open buildingSMART **IFC4 ADD2** as the model of record.

Crucially, BIMWorks is **AI-First by design**: every modeling action, constraint, and edit is exposed through a typed **CommandBus** (JSON Schema 2020-12). An LLM agent, script, or the built-in Tier-1 Prompt Bar drives the application through the exact same programmatic contract as the graphical Ribbon — no UI clicking, no hallucinated parameters, and full transactional integrity.

---

## 2. Core Architectural Decisions (GLM Master Spec v2.1)

```
myproject.orlt (Standard ZIP Container)
├── model.ifc          # IFC4 ADD2 STEP file — the model of record (Bonsai / Solibri compatible)
├── parametric.json    # overlay: constraints, join policies, parameters — ALL in decimal feet
├── views/default.json # view range, detail level, templates, filters
└── meta.json          # schema version (2.1), app name, license (GPL-3.0), units, journal tail
```

### 1. Hybrid Container (`.orlt` ZIP)
- **Problem solved**: IFC is an archival interchange format without parametric recompute semantics; custom property sets (`Pset_*`) cannot solve or re-execute live constraints.
- **Solution**: BIMWorks stores projects in a `.orlt` container. External tools (Solibri, Bonsai, Revit) open `model.ifc` directly. In BIMWorks, the `parametric.json` overlay re-attaches by GUID to provide live constraints, wall joins, and type formulas. If an IFC file is edited externally, stale entries are flagged gracefully without data corruption.

### 2. Internal Units: Decimal Feet
- **Revit-standard internal precision**: All coordinates, offsets, wall lengths, and solver math strictly use double-precision **decimal feet**.
- **Clean unit boundaries**: Display formatting (Fractional Imperial `12' - 6 1/2"`, Decimal Feet `12.50'`, Metric `3810 mm`, or `3.81 m`) occurs strictly at the UI presentation layer or STEP serializer boundary.

### 3. Tier-0 CommandBus (JSON Schema 2020-12)
- **Typed program synthesis**: AI drivers and UI events execute typed commands against the CommandBus (`/api/command` and `/api/transaction`).
- **Atomic transactions**: Multi-command transactions execute atomically with automatic rollbacks on invalid constraints and origin tagging (`origin: "ui" | "ai"`).
- **Append-only journal**: Transaction history is logged to an audit replay journal for full reproducibility and 1-click AI rollback.

### 4. Wall Join Subsystem
- **Plan-level polygon corner joins**: Default **Butt** join removes overlapping dividing seam lines in plan views; **Miter** and **Square-off** are selectable per join.
- **Per-endpoint join control**: Supports `allow_join_at_end(0 | 1)` (matching Revit's `WallUtils.IsWallJoinAllowedAtEnd`).

### 5. Revit-Exact View Range Rules
- Slicing logic strictly enforces Revit's confirmed view range rule:
  > *Walls shorter than 6 feet (or 2 meters) are not cut, even if they intersect the cut plane.*
- Low walls and sill projections render in `.projection` outline without poché hatch.

### 6. Tier-1 In-App AI Prompt Bar ("Ask/Do" Bar)
- Positioned directly above the Status Bar (<kbd>Ctrl</kbd> + <kbd>Enter</kbd> or <kbd>/</kbd>).
- Translates natural language requests into typed plans (`WallCreate`, `DoorInsert`, `ConstraintEqualize`, etc.).
- **Preview-before-commit**: Viewport displays a plan preview chip before committing. Pressing <kbd>Enter</kbd> executes the plan as ONE undo step; <kbd>Esc</kbd> discards without mutation.

---

## 3. UI/UX Muscle Memory & Two-Letter Hotkeys

BIMWorks preserves standard architectural hotkeys and Revit navigation conventions:

| Tool | Hotkey | Function |
|---|---|---|
| **Wall** | `WA` | Place continuous architectural standard-case walls |
| **Door** | `DR` | Insert hosted door with automatic `IfcRelVoidsElement` wall void |
| **Window** | `WN` | Insert hosted window with sill and opening cut |
| **Floor / Slab** | `SB` | Sketch-based boundary slab extrusion |
| **Roof** | `RF` | Footprint roof with pitch angles |
| **Grid** | `GR` | Planar datum grid line (`A`, `B`, `1`, `2`) |
| **Level** | `LL` | Storey datum height (`Level 1`, `Level 2`, `Roof`) |
| **Align & Lock** | `AL` | Select reference and target edge with padlock constraint |
| **Equalize** | `EQ` | Equalize interior elements across a boundary span |
| **Aligned Dimension** | `DI` | Place temporary or permanent linear dimensions |
| **Section Box** | `BX` | Real-time 3D GPU stencil-capped section box |
| **Open File** | `Ctrl + O` | Open `.orlt` container or `.ifc` file |
| **Save Project** | `Ctrl + S` | Save `.orlt` hybrid project container |
| **AI Prompt Bar** | `/` or `Ctrl + Enter` | Focus Tier-1 AI prompt bar |
| **Flip Orientation** | `Space` | Flip wall exterior side or door swing hand |
| **Cancel / Clear** | `Esc` | Clear selection, dismiss tool, or discard AI preview |

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (WEBVIEW / BROWSER)                  │
│ React 19 + TypeScript + Tailwind CSS + Dockview MDI + Three.js + Zustand│
│ • Ribbon (Architecture, Annotate, View, Manage)                         │
│ • Project Browser & Properties Palette (Dynamic Unit Formatting)        │
│ • 3D Viewport (WebGL2, Stencil Capping) & 2D Vector Canvas              │
│ • Tier-1 AI Prompt Bar & Replay Journal Drawer                          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ JSON-RPC / REST (localhost:8008)
┌────────────────────────────────────▼────────────────────────────────────┐
│                       CORE BIM ENGINE (PYTHON / C++)                    │
│ 1. Model Store: In-memory IFC4 ADD2 + Parametric JSON Overlay           │
│ 2. CommandBus & Transaction Manager (JSON Schema 2020-12, Undo/Redo)    │
│ 3. Geometry Builders: IfcOpenShell v0.8.0, IfcGeom, Wall Join Manager   │
│ 4. Vector Slicing Engine: View Range (6-ft rule), SVG Poché Hatching    │
│ 5. Sheet & PDF Engine: PyMuPDF Vector PDF Compiler                      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Container Serialization
┌────────────────────────────────────▼────────────────────────────────────┐
│                    HYBRID CONTAINER ARCHIVE (.orlt)                     │
│ model.ifc + parametric.json + views/*.json + meta.json                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Getting Started

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **Python**: v3.10 to v3.12 (with `pip`)

### 1. Clone the Repository
```bash
git clone https://github.com/Axotopia/BIMWorks.git
cd BIMWorks
```

### 2. Set Up & Run the Python Backend
```bash
# Create and activate virtual environment (optional)
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

# Install dependencies
pip install fastapi uvicorn pydantic ifcopenshell pymupdf numpy

# Launch backend sidecar (port 8008)
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8008
```

### 3. Set Up & Run the Frontend
```bash
# In the project root:
npm install

# Start Vite development server
npm run dev
```

Open your browser at `http://localhost:5173/`.

---

## 6. Verification & Automated Testing

Run the automated backend test suite covering `.orlt` container serialization, CommandBus schemas, wall joins, and view range slicing:

```bash
python scratch/test_v2_core.py
```

Expected output:
```text
1. Testing clean model setup...
2. Testing CommandBus execution (WallCreate, DoorInsert)...
3. Testing Wall Joins...
4. Testing 2D slicing and 6-foot wall view range rule...
   -> Slicing verified: Wall 1 is .cut, Wall 2 is .projection (< 6ft)!
5. Testing Transaction batching with AI origin...
6. Testing .orlt Hybrid Container export & round-trip reload...
   -> .orlt exported successfully (3097 bytes)
   -> .orlt reloaded successfully! Elements restored: 3
7. Testing Command Schema Export...
   -> Exported 13 typed command schemas (JSON Schema 2020-12)

ALL V2 CORE TESTS PASSED SUCCESSFULLY!
```

---

## 7. CommandBus API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/commands/schema` | `GET` | Exports JSON Schema 2020-12 definitions for all registered commands |
| `/api/command` | `POST` | Executes a single typed command against the engine |
| `/api/transaction` | `POST` | Executes an atomic batch of commands with origin tag (`ui` / `ai`) |
| `/api/transaction/undo` | `POST` | Rolls back the latest transaction |
| `/api/transaction/redo` | `POST` | Re-executes the latest undone transaction |
| `/api/transaction/journal` | `GET` | Fetches recent replay journal transactions |
| `/api/project/export-orlt` | `GET` | Exports complete `.orlt` hybrid ZIP container |
| `/api/project/load-orlt` | `POST` | Unpacks and loads `.orlt` container |
| `/api/export/ifc` | `GET` | Exports standard IFC4 STEP file (`.ifc`) |
| `/api/wall/join` | `POST` | Configures wall endpoint join policy (`butt`, `miter`, `allow_join`) |
| `/api/slice/2d` | `GET` | Returns 2D SVG vector linework (`.cut`, `.projection`, `.overhead`) |

---

## 8. License

BIMWorks is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See [`LICENSE`](LICENSE) for full details.
