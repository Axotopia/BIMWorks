import os, sys
backend_path = os.path.abspath("backend")
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

from ifc_service import bim_manager

minimal_ifc = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('test.ifc','2026-10-13T12:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0123456789012345678901',$,'Uploaded Test House',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-21;
"""

res = bim_manager.load_ifc_content(minimal_ifc, "minimal.ifc")
print("BimManager result:", res)
geom = bim_manager.get_geometry_buffers()
print("Geom meshes:", len(geom["meshes"]), "levels:", len(geom["levels"]))
print("SUCCESS!")
