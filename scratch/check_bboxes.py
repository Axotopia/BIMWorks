import sys, os, re
sys.path.insert(0, os.getcwd())
from backend.ifc_service import BimModelManager
mgr = BimModelManager()
mgr.load_ifc_file('Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc')
plan = mgr.slice_2d_vector_plan()

for cat in ['cut_paths', 'projection_paths', 'swing_paths', 'grids', 'slabs']:
    min_x, max_x, min_y, max_y = 1e9, -1e9, 1e9, -1e9
    for p in plan[cat]:
        d = p.get('d', '')
        # extract all (x, y) coordinates after M, L, or at end of A
        # regex for commands and coordinates
        coords = re.findall(r'([ML])\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', d)
        for _, x, y in coords:
            fx, fy = float(x), float(y)
            min_x, max_x = min(min_x, fx), max(max_x, fx)
            min_y, max_y = min(min_y, fy), max(max_y, fy)
        arc_ends = re.findall(r'A\s+(?:-?\d+\.?\d*\s+){5}(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', d)
        for x, y in arc_ends:
            fx, fy = float(x), float(y)
            min_x, max_x = min(min_x, fx), max(max_x, fx)
            min_y, max_y = min(min_y, fy), max(max_y, fy)
    print(f'{cat} bbox: X=[{min_x:.2f}, {max_x:.2f}], Y=[{min_y:.2f}, {max_y:.2f}]')
