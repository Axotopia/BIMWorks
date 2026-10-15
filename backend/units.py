"""
BIMWorks - Units.

GLM Master Spec v2.3 §11.3: **the internal unit is decimal feet.** Revit uses
decimal feet internally too, which is why the spec chose it — imperial display,
metric display and fractional inches are all *presentation*.

This module is the single conversion point. Two rules:

1. Anything stored on the model (IFC attributes, `element_meta`, `parametric.json`
   overlay, command parameters) is in **decimal feet**.
2. Nothing outside this module should contain a bare `0.3048` or a metric
   dimension. If a dimension needs converting, it comes from here.

Before P2 the code was the opposite: the engine was metric (IFC declared METERS,
defaults were 3.0 m / 0.2 m / 1.2 m cut plane) while the overlay and `meta.json`
*claimed* decimal feet. The declaration was a lie in both directions. P2 makes
the declaration true.
"""

#: Exact by definition: 1 international foot = 0.3048 m.
METRES_PER_FOOT = 0.3048

#: Unit the IFC model of record is authored in. IFC is natively metric and this
#: is also the only setting under which ifcopenshell's geometry usecases agree
#: with each other (see the note in ifc_service.py), so the file is metres while
#: the overlay and the rest of the application are decimal feet.
IFC_LENGTH_UNIT = "METERS"
IFC_LENGTH_UNIT_IS_METRIC = True

#: What every stored length is in.
INTERNAL_UNIT = "decimal_feet"

#: Recorded in the overlay so a reader knows whether to convert. "none" means the
#: overlay is already in `INTERNAL_UNIT`.
UNIT_CONVERSION_SOURCE = "none"


def feet_to_metres(feet: float) -> float:
    """Decimal feet -> metres. Used at the module boundary, nowhere else."""
    return feet * METRES_PER_FOOT


def metres_to_feet(metres: float) -> float:
    """Metres -> decimal feet."""
    return metres / METRES_PER_FOOT


def inches_to_feet(inches: float) -> float:
    """Inches -> decimal feet. Nominal building dimensions are specified in inches."""
    return inches / 12.0


def feet_to_inches(feet: float) -> float:
    """Decimal feet -> inches."""
    return feet * 12.0


# ---------------------------------------------------------------------------
# Common architectural dimensions in decimal feet.
#
# These exist so the builders and the UI do not carry metric literals. A wall
# "10 ft high" is `FEET_10`; a 2x4 partition is `INCHES_4_7_8` thick; the
# Revit view-range default cut plane is 4'-0".
# ---------------------------------------------------------------------------
INCHES_2 = inches_to_feet(2.0)
INCHES_4 = inches_to_feet(4.0)
INCHES_4_7_8 = inches_to_feet(4.875)      # interior partition
INCHES_0_625 = inches_to_feet(0.625)      # 5/8" face nudge for hosted openings
INCHES_6 = inches_to_feet(6.0)
INCHES_8 = inches_to_feet(8.0)
INCHES_10 = inches_to_feet(10.0)          # exterior CMU
INCHES_12 = inches_to_feet(12.0)

FEET_0 = 0.0
FEET_1 = 1.0
FEET_2 = 2.0
FEET_3 = 3.0
FEET_4 = 4.0                              # default view-range cut plane
FEET_6 = 6.0                              # Revit <6 ft not-cut rule
FEET_8 = 8.0
FEET_9 = 9.0
FEET_10 = 10.0                            # default wall height
FEET_12 = 12.0
FEET_20 = 20.0
FEET_30 = 30.0

# Opening defaults, sized from their nominal inch dimensions.
DOOR_WIDTH_36 = inches_to_feet(36.0)
DOOR_HEIGHT_84 = inches_to_feet(84.0)
WINDOW_WIDTH_48 = inches_to_feet(48.0)
WINDOW_HEIGHT_48 = inches_to_feet(48.0)
WINDOW_SILL_36 = inches_to_feet(36.0)

#: IFC door/window panel and frame thicknesses.
DOOR_PANEL_THICKNESS = inches_to_feet(1.75)
WINDOW_FRAME_THICKNESS = inches_to_feet(2.375)


def format_feet_inches(feet: float, round_to: float = 1.0 / 192.0) -> str:
    """
    Formats decimal feet as an architectural string, e.g. 0.6667 -> `8"`,
    9.7083 -> `9'-8 1/2"`. Rounds to the nearest 1/16" by default, the
    convention Revit uses for type parameters.

    `round_to` is expressed as a fraction of a FOOT, because that is the unit the
    whole module works in. The default is therefore 1/192 ft == 1/16", whereas the
    function previously defaulted to 1/16 ft == 3/4" — a coarser grid than any
    architectural dimension uses, which is why an 8" sill read `8 1/4"` and a 48"
    width read `48 1/4"`. The arithmetic now runs in integer 1/16" so an exact
    value cannot acquire a fraction from binary rounding.
    """
    if feet is None:
        return "—"
    sixteenths_per_inch = 16
    negative = feet < 0
    total_sixteenths = round(abs(feet) * 12.0 * sixteenths_per_inch)
    if round_to and round_to > 0:
        step = max(1, int(round(round_to * 12.0 * sixteenths_per_inch)))
        total_sixteenths = int(round(total_sixteenths / step)) * step

    whole_feet = total_sixteenths // (12 * sixteenths_per_inch)
    remainder_sixteenths = total_sixteenths - whole_feet * 12 * sixteenths_per_inch
    whole_inches = remainder_sixteenths // sixteenths_per_inch
    frac_sixteenths = remainder_sixteenths - whole_inches * sixteenths_per_inch

    frac_str = ""
    if frac_sixteenths:
        sixteenths = frac_sixteenths
        divisor = sixteenths_per_inch
        while sixteenths % 2 == 0 and divisor > 1:
            sixteenths //= 2
            divisor //= 2
        frac_str = f" {sixteenths}/{divisor}"

    sign = "-" if negative else ""
    if whole_feet:
        return f'{sign}{whole_feet}\'-{whole_inches}{frac_str}"'
    return f'{sign}{whole_inches}{frac_str}"'
