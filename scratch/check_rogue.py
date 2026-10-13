import sys, os
sys.path.insert(0, os.getcwd())
import ifcopenshell, re
from backend.ifc_service import BimModelManager

mgr = BimModelManager()
mgr.load_ifc_file('Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc')
plan = mgr.slice_2d_vector_plan()

for p in plan['swing_paths']:
    d = p.get('d', '')
    nums = [float(x) for x in re.findall(r'-?\d+\.?\d*', d)]
    xs = nums[0::2]
    ys = nums[1::2]
    if any(y < 25 or x > 0 for x, y in zip(xs, ys)):
        guid = p['guid']
        meta = mgr.element_meta.get(guid, {})
        print(f"Rogue swing: guid={guid}, class={meta.get('ifc_class')}, name={meta.get('name')}")
        print(f"  offset={meta.get('offset_along_wall')}, width={meta.get('width')}, host={meta.get('host_wall_guid')}")
        host_meta = mgr.element_meta.get(meta.get('host_wall_guid', ''), {})
        print(f"  host wall: {host_meta.get('name')}, start={host_meta.get('start')}, end={host_meta.get('end')}, ang={host_meta.get('angle')}, len={host_meta.get('length')}")
        print(f"  d={d}")
