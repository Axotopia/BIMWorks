import sys, os, math
sys.path.insert(0, os.path.abspath('backend'))
from ifc_service import bim_manager

bim_manager.load_ifc_file(r'Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc')

# Find the main roof
roof_guid = '2I$l9wg8fBFQNWvuSFfdhF'
m = bim_manager.element_meta.get(roof_guid)
print("Roof before update:", m.get('name'), "bbox:", m.get('bbox'))
print("Polygon:", m.get('polygon'))

# Define pitched roof builder
def build_pitched_roof_mesh(poly, elevation=6.0, thickness=0.3, pitch_deg=15.0):
    n = len(poly)
    rad = math.radians(pitch_deg)
    ys = [p[1] for p in poly]
    min_y, max_y = min(ys), max(ys)
    mid_y = (min_y + max_y) / 2.0
    half_span = (max_y - min_y) / 2.0 if max_y > min_y else 1.0
    
    verts = []
    # Bottom face
    for x, y in poly:
        rise = (half_span - abs(y - mid_y)) * math.tan(rad)
        verts.extend([float(x), float(y), float(elevation + max(0.0, rise))])
    # Top face
    for x, y in poly:
        rise = (half_span - abs(y - mid_y)) * math.tan(rad)
        verts.extend([float(x), float(y), float(elevation + max(0.0, rise) + thickness)])
    
    faces = []
    for i in range(1, n - 1):
        faces.extend([0, i + 1, i])
    for i in range(1, n - 1):
        faces.extend([n, n + i, n + i + 1])
    for i in range(n):
        nxt = (i + 1) % n
        faces.extend([i, n + i, n + nxt])
        faces.extend([i, n + nxt, nxt])
    return verts, faces

v, f = build_pitched_roof_mesh(m.get('polygon', [(0,0),(10,0),(10,10),(0,10)]), 565.0, 0.35, 22.5)
print(f"Pitched roof generated: {len(v)//3} vertices, {len(f)//3} triangles")
