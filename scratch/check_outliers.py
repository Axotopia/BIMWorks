import sys, os
sys.path.insert(0, os.getcwd())
import ifcopenshell, re
from backend.ifc_service import BimModelManager

mgr = BimModelManager()
mgr.load_ifc_file('Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc')
plan = mgr.slice_2d_vector_plan()

for cat in ['cut_paths', 'projection_paths', 'swing_paths', 'grids', 'slabs']:
    print(f'=== Category: {cat} (count: {len(plan[cat])}) ===')
    for item in plan[cat]:
        d = item.get('d', '')
        if 'circle_center' in item:
            cx, cy = item['circle_center']
            if cy < 20 or cy > 55 or cx < -35 or cx > 5:
                print(f'  Outlier circle in {cat}: guid={item.get("guid")}, tag={item.get("tag")}, center=({cx}, {cy})')
        tokens = re.findall(r'([ML])\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', d)
        for cmd, x, y in tokens:
            fx, fy = float(x), float(y)
            if fy < 20 or fy > 55 or fx < -35 or fx > -5:
                print(f'  Outlier point in {cat}: guid={item.get("guid")}, tag={item.get("tag")}, cmd={cmd}, pt=({fx}, {fy}), d={d[:80]}')
