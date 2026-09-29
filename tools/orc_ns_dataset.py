"""Build the VPP validation dataset from ORC non-spinnaker certificates.

Input: a JSON map RefNo -> certificate fields, as downloaded from
  https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo=<ref>&ext=json
(one certificate per boat class from
  https://data.orc.org/public/WPub.dll?action=activecerts&Family=5&VPPYear=2026).

Output: test-data/orc-ns-2026.json, read by tools/vpp_validate.ts.

Mapping (certificate field -> calculator input):
  LOA            -> loa_m
  IMSL           -> lwl_m   (ORC IMS sailing length; certificates carry no
                             LWL, so this is the nearest available length)
  MB             -> beam_m  (maximum beam)
  Draft          -> draft_m
  Dspl_Sailing   -> displacement_kg
  Area_Main + Area_Jib -> sail_area_upwind_m2 (no downwind sail: NS)

Reference speeds: the certificate's Allowances are seconds per nautical
mile, so boat speed (kn) = 3600 / allowance.
  R<angle>[k]    at TWA <angle>, TWS WindSpeeds[k]
  Beat[k]        upwind VMG allowance at BeatAngle[k]:
                 boat speed = (3600 / Beat) / cos(BeatAngle)
  Run[k]         downwind VMG allowance at GybeAngle[k]:
                 boat speed = (3600 / Run) / cos(180° - GybeAngle)
"""

import json
import math
import sys

src, dst = sys.argv[1], sys.argv[2]
certs = json.load(open(src))
boats, skipped = [], []
for ref, c in certs.items():
    if "_error" in c:
        skipped.append((ref, c["_error"]))
        continue
    need = ["LOA", "IMSL", "MB", "Draft", "Dspl_Sailing", "Area_Main", "Area_Jib", "Allowances"]
    missing = [k for k in need if not c.get(k)]
    if missing:
        skipped.append((ref, "missing " + ",".join(missing)))
        continue
    a = c["Allowances"]
    tws = a["WindSpeeds"]
    pts = []
    for ang in a["WindAngles"]:
        for k, t in enumerate(tws):
            r = a[f"R{ang}"][k]
            if r and r > 0:
                pts.append({"twa": ang, "tws_kt": t, "bs_kt": round(3600.0 / r, 4), "kind": "angle"})
    for k, t in enumerate(tws):
        b, ba = a["Beat"][k], a["BeatAngle"][k]
        if b and b > 0 and ba:
            pts.append({"twa": ba, "tws_kt": t,
                        "bs_kt": round(3600.0 / b / math.cos(math.radians(ba)), 4), "kind": "beat"})
        r, ga = a["Run"][k], a["GybeAngle"][k]
        if r and r > 0 and ga:
            pts.append({"twa": ga, "tws_kt": t,
                        "bs_kt": round(3600.0 / r / math.cos(math.radians(180.0 - ga)), 4), "kind": "run"})
    boats.append({
        "ref": ref,
        "name": c.get("YachtName"),
        "cls": (c.get("Class") or "").strip(),
        "source": c["_source"],
        "specs": {
            "loa_m": c["LOA"], "lwl_m": c["IMSL"], "beam_m": c["MB"], "draft_m": c["Draft"],
            "displacement_kg": c["Dspl_Sailing"],
            "sail_area_upwind_m2": round(c["Area_Main"] + c["Area_Jib"], 2),
            "sail_area_downwind_m2": 0,
            "rig_type": "sloop", "keel_type": "fin", "hull_type": "monohull",
        },
        "orc": {k: c.get(k) for k in ["Age_Year", "Builder", "Designer", "WSS", "Dspl_Measurement",
                                      "Area_Main", "Area_Jib", "Area_Sym", "Area_Asym", "CrewWT", "C_Type"]},
        "points": pts,
    })

out = {
    "description": "ORC 2026 non-spinnaker certificates, one per boat class; reference speeds are ORC VPP output (3600/allowance). See tools/orc_ns_dataset.py for the field mapping.",
    "list_source": "https://data.orc.org/public/WPub.dll?action=activecerts&Family=5&VPPYear=2026",
    "boats": boats,
    "skipped": skipped,
}
json.dump(out, open(dst, "w"), separators=(",", ":"))
print(f"{len(boats)} boats written to {dst}; {len(skipped)} skipped")
