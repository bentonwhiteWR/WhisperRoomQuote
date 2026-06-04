// AUTO-GENERATED from Josh's Excel POs (ORDERING PURCHASE ORDERS) — 41 vendors,
// 224 catalog items. Companion to seed-test-vendors.js (the original 3).
//
// Provenance / regeneration: parsed from the legacy .xls files with the Python
// scripts kept in `C:\Users\bento\Documents\Claude\WR PO System\`
// (parse_pos.py -> vendors.json, then gen_seed.py -> this file). Re-run those to
// refresh after Josh updates the spreadsheets.
//
// EXCLUDED on purpose: Carpenter + Bertelkamp (already curated in
// seed-test-vendors.js), and Knoxville Corrugated (374-row spec master — enter
// manually). Foss = curated vendor + 3 new materials, hand-built below.
// Caveats: mfg/part# mostly folded into description; a few vendors have blank/TBD
// prices (Auralex lists none); Guardian descriptions carry some trailing noise.
//
// One-time importer. HOW TO USE:
//   1. Log into staging, open the /vendors page
//   2. Open DevTools console (Ctrl+Shift+J)
//   3. Paste this whole file, press Enter
//   4. Refresh /vendors
// Idempotent: updates by name (PATCH) if the vendor already exists, else POST.
(async () => {
  const VENDORS = [
  {
    "name": "A & M Supply",
    "address_lines": [
      "Knoxville, TN"
    ],
    "phone": "877-786-3464",
    "contacts": [],
    "send_to_emails": [
      "knoxvillesales@a-msupply.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "34mdfpp48",
        "description": "49 X 97 X 3/4\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 264,
        "unit_price": 47.04,
        "price_updated_date": "2025-04-24"
      },
      {
        "sku": "34mdfpp49",
        "description": "49 X 109 X 3/4\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 80,
        "unit_price": 50.148,
        "price_updated_date": "2022-03-08"
      },
      {
        "sku": "34mdfpp510",
        "description": "61 X 121 X 3/4\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30,
        "unit_price": 82.62,
        "price_updated_date": "2022-03-30"
      },
      {
        "sku": "1mdfpp58",
        "description": "61 X 97 X 1\" MDF",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 21,
        "unit_price": 84.02,
        "price_updated_date": "2025-04-24"
      },
      {
        "sku": "12mdfpp48",
        "description": "49 X 97 X 1/2\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 39.02,
        "price_updated_date": "2022-06-30"
      },
      {
        "sku": "14mdf48",
        "description": "49 X 97 X 1/4\" REGULAR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 10.88,
        "price_updated_date": "2021-11-30"
      },
      {
        "sku": "38mdfpp48",
        "description": "49 X 97 X 3/8\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 16.32,
        "price_updated_date": "2021-11-30"
      },
      {
        "sku": "SP34BCRP",
        "description": "49 X 8 X 23/32\" BC Radiata Pine",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 52,
        "unit_price": 44.4,
        "price_updated_date": "2026-03-12"
      },
      {
        "sku": "14mdfpp48",
        "description": "49 X 97 X 1/4\" PREMIER PLUS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 25,
        "unit_price": 0,
        "price_updated_date": ""
      },
      {
        "sku": "14rh",
        "description": "4 X 8 X 1/4\" REGULAR HRDB S2S",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 10.24,
        "price_updated_date": ""
      },
      {
        "sku": "34CDXP",
        "description": "4 X 8 X 3/4\" SHEATING PINE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 108,
        "unit_price": 18,
        "price_updated_date": ""
      },
      {
        "sku": "77592043-48",
        "description": "FORMICA LAMINATE - SELECT CHERRY 48\" X 96\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 36.8,
        "price_updated_date": "2013-06-03"
      }
    ]
  },
  {
    "name": "AC Infinity Inc.",
    "address_lines": [
      "815 Echelon Ct,",
      "City of Industry, CA 91744",
      "Bernard Muniz"
    ],
    "phone": "626 923 6399",
    "contacts": [],
    "send_to_emails": [
      "Dealers@acinfinity.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "AI-CLS4",
        "description": "CLOUDLINE S4, Quiet Inline Duct Fan System with Speed Controller, 4-Inch Quote # 011922 04",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 69.3,
        "price_updated_date": "2023-11-14"
      },
      {
        "sku": "CTR63A",
        "description": "CONTROLLER 63, Wireless Remote Fan Controller Quote # 011922 04",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 22.49,
        "price_updated_date": "2022-01-21"
      },
      {
        "sku": "AI-DT A4",
        "description": "Flexible Four-Layer Ducting, 25-Ft Long, 4-Inch Quote # 011922 04",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 13.99,
        "price_updated_date": "2022-01-21"
      }
    ]
  },
  {
    "name": "APPLIED ADHESIVES",
    "address_lines": [
      "6035 Baker Road,",
      "Minnetonka, MN 55345"
    ],
    "phone": "615-519 3870",
    "contacts": [
      {
        "name": "Matt Stauder"
      },
      {
        "name": "Rachel Flanigan"
      }
    ],
    "send_to_emails": [
      "mstauder@appliedproducts.com",
      "rflanigan@appliedproducts.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "SL1003 DR",
        "description": "55 Gal. Drum EA 9350.0",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 17,
        "price_updated_date": "2025-08-21"
      },
      {
        "sku": "BSA 454",
        "description": "5 Gal. Pails EA 96.5",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 19.3,
        "price_updated_date": "2025-05-14"
      },
      {
        "sku": "BSA 454",
        "description": "54 Gal. Drum EA 12094.92 9350.0 9350.0",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 6,
        "unit_price": 37.33,
        "price_updated_date": "2025-05-14"
      }
    ]
  },
  {
    "name": "ARMOR CNC",
    "address_lines": [
      "PO BOX 589",
      "GLEN HEAD, NY 11545",
      "PO# 509512"
    ],
    "phone": "516-415-2621",
    "contacts": [],
    "send_to_emails": [
      "eric@armorcnc.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "PREMIUM CLASS MOTOR",
        "description": "each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 1250,
        "price_updated_date": ""
      },
      {
        "sku": "PREMIUM CLASS DIAGNOSTIC CABLE",
        "description": "each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 75,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "AURALEX ACOUSTICS",
    "address_lines": [
      "8802 Bash Street, Suite A",
      "Indianapolis, IN 46256"
    ],
    "phone": "317-842-2600",
    "contacts": [],
    "send_to_emails": [
      "orders@auralex.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "*** ATTENTION! DO NOT SHIP WITH ROADRUNNER TRANSPORTATION ***",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "2\" STUDIOFOAM",
        "description": "CHARCOAL GRAY (2\"X24\"X48\") BOXES OF 12",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "2\" STUDIOFOAM",
        "description": "BURGUNDY (2\"X24\"X48\") BOXES OF 12",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "2\" STUDIOFOAM",
        "description": "PURPLE (2\"X24\"X48\") BOXES OF 12",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "2\" STUDIOFOAM",
        "description": "BLUE (2\"X24\"X48\") BOXES OF 12",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "2\" STUDIOFOAM",
        "description": "ORANGE (2\"X24\"X48\") BOXES OF 12",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 60,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "1\" STUDIOFOAM",
        "description": "CHARCOAL GRAY (1\"X24\"X48\") BOXES OF 20",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "LENRD",
        "description": "CHARCOAL GRAY (12\"X12\"X24\") BOXES OF 8",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 15,
        "unit_price": "",
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "AUDIMUTE",
    "address_lines": [
      "23945 Mercantile Road - Suite H",
      "Beachwood, Ohio 44122",
      "216 591-1891 x320"
    ],
    "phone": "",
    "contacts": [
      {
        "name": "ELIZABETH WADE"
      }
    ],
    "send_to_emails": [
      "EWade@audimute.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "",
        "description": "2' x 4' Audimute Panels - BIRCH",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 8,
        "unit_price": 60,
        "price_updated_date": "2023-07-24"
      },
      {
        "sku": "",
        "description": "2' x 4' Audimute Panels - ONYX",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 60,
        "price_updated_date": "2023-07-24"
      },
      {
        "sku": "",
        "description": "Pack of WhisperRoom Hang Tabs with Velcro 2 per bag",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 12,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "FP-200-400-Asteroid",
        "description": "Fabric Acoustic Panels - Gray ea",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 75,
        "unit_price": 76,
        "price_updated_date": "2024-01-18"
      },
      {
        "sku": "FP-200-400-Lapis",
        "description": "Fabric Acoustic Panels - Blue ea",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 25,
        "unit_price": 76,
        "price_updated_date": "2024-01-18"
      },
      {
        "sku": "",
        "description": "Hangtabs ea",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 300,
        "unit_price": 1,
        "price_updated_date": "2024-01-18"
      }
    ]
  },
  {
    "name": "BAILEY",
    "address_lines": [
      "2340 Wheeler St.",
      "Knoxville, TN 37917",
      "(865) 401-6851"
    ],
    "phone": "",
    "contacts": [
      {
        "name": "Karen Blancas"
      }
    ],
    "send_to_emails": [
      "kblancas@baileycompany.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "COLLECT - ABF Account# 189059",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "ECO angle 120 - 10\" 120\" 10\"",
        "description": "each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 533,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "BECKER PUMPS CORP.",
    "address_lines": [
      "100 EAST ASCOT LANE",
      "CUYAHOGA FALLS, OH 44223"
    ],
    "phone": "330-940-1045",
    "contacts": [
      {
        "name": "BRAD HUGHES"
      },
      {
        "name": "BRYAN EADS"
      }
    ],
    "send_to_emails": [],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "FOB ORIGIN - COLLECT",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "84040110W00",
        "description": "FILTER CARTRIDGE -POLYESTER CORROSION RESISTANT POLYESTER ELEMENT",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 137.16,
        "price_updated_date": ""
      },
      {
        "sku": "PACKAGINGPARTS",
        "description": "PACKAGING FEE - PARTS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 7.99,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "BIBLE'S MACHINING",
    "address_lines": [
      "301 CHEMWOOD DRIVE",
      "NEWPORT, TN 37821"
    ],
    "phone": "(423) 623-1004",
    "contacts": [
      {
        "name": "KENAN BIBLE"
      }
    ],
    "send_to_emails": [
      "kbible@biblesmachining.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "",
        "description": "SPLINE TOOL WHEELS (SOLID)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "SPLINE TOOL WHEELS (GROOVED)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": "",
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "SPLINE TOOL HANDLES",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5,
        "unit_price": 55,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "BUILD.COM",
    "address_lines": [
      "402 Otterson Dr, Ste 100",
      "Chico, CA 95928"
    ],
    "phone": "800.375.3403 x 6124",
    "contacts": [
      {
        "name": "Oliver Gunn"
      }
    ],
    "send_to_emails": [
      "oliver.gunn@build.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "NOTE: SHIP ONLY THE MAKE AND MODEL SPECIFIED ABOVE. NOTE: SHIP COMPLETE ORDERS ONLY..",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "DHDW107CD",
        "description": "Robinson Single Cylinder /unit Keyed Entry Door Lever Set Satin Nickel 5-Pin Schlage, Keyed Alike KEY CODE 64283",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 600,
        "unit_price": 15.95,
        "price_updated_date": "2021-10-12"
      },
      {
        "sku": "SCHLAGE SC1",
        "description": "Single Key Blank /each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1200,
        "unit_price": 1,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "CasterDepot",
    "address_lines": [],
    "phone": "615-256-9065",
    "contacts": [
      {
        "name": "Jason Good"
      }
    ],
    "send_to_emails": [
      "JAG@casterdepot.com",
      "indy@casterdepot.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "CASTERS",
        "description": "PSQ30119ZN-3R",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 320,
        "unit_price": 6.04,
        "price_updated_date": "2025-03-17"
      },
      {
        "sku": "CASTERS",
        "description": "PSQ30119ZN-3RB",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 160,
        "unit_price": 6.28,
        "price_updated_date": "2026-01-13"
      },
      {
        "sku": "C007.282",
        "description": "31-0620-UPB-S-B",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 28,
        "unit_price": 19.8,
        "price_updated_date": "2025-04-24"
      },
      {
        "sku": "C006.497",
        "description": "31-0620-UPB-S",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 28,
        "unit_price": 15.88,
        "price_updated_date": "2025-04-24"
      }
    ]
  },
  {
    "name": "CLEAN SEAL, INC.",
    "address_lines": [
      "20900 West Ireland Road",
      "South Bend, IN 46680-2919"
    ],
    "phone": "800-366-3682 x 5060",
    "contacts": [
      {
        "name": "Kat Vervynckt"
      }
    ],
    "send_to_emails": [
      "kat@cleanseal.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "4972H2-1M",
        "description": "TBD Tape Die # 4972P (.187\" x .500\" EPDM rectangle) with 3/8\" acrylic adhesive. Color is Black. (500'/roll)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2000,
        "unit_price": 0.354,
        "price_updated_date": "2025-09-30"
      },
      {
        "sku": "4969H2-500",
        "description": "TBD Tape Die # 4969P (.187\" x .750\" EPDM rectangle) with 5/8\" acrylic adhesive. Color is Black. (500'/roll)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4000,
        "unit_price": 0.411,
        "price_updated_date": "2025-09-30"
      },
      {
        "sku": "1153B-H2-C",
        "description": "TBD Tape Die # 1153B-P (.250\" x .375\" EPDM D\" section) with 5/8\" acrylic adhesive centered. Material will be 2-cavity. Color is Black. (500'/roll)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5000,
        "unit_price": 0.276,
        "price_updated_date": "2025-09-30"
      },
      {
        "sku": "4974H2-1M",
        "description": "TBD .250 X .750 rect. EPDM taped W/H2 seam seal rubber for \"BARE\" rooms 15 locations 5/8\" adhesive (500'/roll)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10000,
        "unit_price": 0.306,
        "price_updated_date": "2018-04-04"
      },
      {
        "sku": "4971H2-500",
        "description": "TBD .250 X 1 rect. EPDM taped with W/H2 FL/CL rubber for \"BARE\" rooms 17 locations 7/8\" acrylic adhesive (500'/roll)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5000,
        "unit_price": 0.468,
        "price_updated_date": "2017-11-17"
      }
    ]
  },
  {
    "name": "Commercial Testing Company",
    "address_lines": [
      "1215 South Hamilton Street",
      "Dalton, GA 30722"
    ],
    "phone": "706-278-3935",
    "contacts": [
      {
        "name": "Deuane Jackson"
      }
    ],
    "send_to_emails": [
      "djackson@commercialtesting.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "ASTM E 84-03b",
        "description": "Standard Method of Test for Surface Burning Characteristics of Building Materials",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 870,
        "price_updated_date": "2025-06-18"
      }
    ]
  },
  {
    "name": "DUO-FAST",
    "address_lines": [
      "3 CHARTER COURT, SUITE A",
      "JOHNSON CITY, TN 37604"
    ],
    "phone": "423-610-1300",
    "contacts": [
      {
        "name": "ROB GIFFORD"
      }
    ],
    "send_to_emails": [
      "jcservice@duofastknoxville.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "ISMRR 1 3/4",
        "description": "ROLL STAPLES FOR BOX STAPLER cases (24 coils / case)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 120,
        "price_updated_date": "2025-10-30"
      },
      {
        "sku": "KP RR1",
        "description": "ROLL CARTON STAPLER 5/8 - 3/4 Quote# 04/001559",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 290,
        "price_updated_date": "2019-02-08"
      },
      {
        "sku": "EZFIT 1840",
        "description": "1 1/4 INCH STAPLES boxes (5000 staples / BOX ) (8 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 16,
        "unit_price": 19,
        "price_updated_date": "2023-10-03"
      },
      {
        "sku": "SEN L15BAB",
        "description": "SENCO 1 1/4 INCH STAPLES boxes (5,000 staples / BOX) (6 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30,
        "unit_price": 30.5,
        "price_updated_date": "2022-03-09"
      },
      {
        "sku": "740RD",
        "description": "1 1/4 INCH NAILS boxes (2000 NAILS / BOX) (9 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 54,
        "unit_price": 7.08,
        "price_updated_date": ""
      },
      {
        "sku": "EZFIT B4424",
        "description": "3/4 INCH D F PINS boxes (5,000 PINS / BOX) (12 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 24,
        "unit_price": 6.475,
        "price_updated_date": "2025-10-30"
      },
      {
        "sku": "EZFIT B4440",
        "description": "1 1/4 INCH D F PINS boxes (5,000 PINS / BOX) (10 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30,
        "unit_price": 9.67,
        "price_updated_date": "2025-10-30"
      },
      {
        "sku": "EZFIT 1816",
        "description": "1/2\" 18 gauge Brads boxes (5000 PINS / BOX)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 6.84,
        "price_updated_date": "2025-10-30"
      },
      {
        "sku": "5416C",
        "description": "3/16\" CROWN X 1/2\" STAPLES boxes (5000 / BOX)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5,
        "unit_price": 8.5,
        "price_updated_date": ""
      },
      {
        "sku": "SL425",
        "description": "3 3/4\" X 131 SMOOTH NAILS boxes (5000 / BOX)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 104.4,
        "price_updated_date": "2012-01-05"
      },
      {
        "sku": "403720",
        "description": "LUBRICATING OIL bottles",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 9,
        "price_updated_date": "2013-04-25"
      },
      {
        "sku": "OMER 50.16",
        "description": "PNEUMATIC STAPLER each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 159,
        "price_updated_date": "2017-09-26"
      },
      {
        "sku": "50180",
        "description": "STAPLES (1/2\" CROWN x 9/16 LENGTH) box (5000 / BOX)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 11.8,
        "price_updated_date": "2017-09-26"
      },
      {
        "sku": "5008C",
        "description": "1/4\" D F STAPLES (5,000 per box) box",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 8.7,
        "price_updated_date": ""
      },
      {
        "sku": "MAX NF255FA/18",
        "description": "18 ga BRAD NAILER each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 149,
        "price_updated_date": "2021-07-27"
      }
    ]
  },
  {
    "name": "Donaldson Company Inc.",
    "address_lines": [
      "PO BOX 207356",
      "DALLAS TX, 75320-7356",
      "Federal Tax ID# 41-0222640",
      "QUOTE#:"
    ],
    "phone": "865-304-5975",
    "contacts": [
      {
        "name": "Alan Waite"
      }
    ],
    "send_to_emails": [
      "alan.waite@donaldson.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "FREIGHT SHIP TO: WHISPERROOM, INC. 116 S. SUGAR HOLLOW RD. MORRISTOWN, TN 37813",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "DFE 3-12",
        "description": "DUST COLLECTOR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 20995.2,
        "price_updated_date": "2018-08-29"
      },
      {
        "sku": "TBI-25",
        "description": "60 CYCLE FAN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 7990.4,
        "price_updated_date": ""
      },
      {
        "sku": "AG8330501",
        "description": "8x8 SQUARE FLANGE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 5034.55,
        "price_updated_date": ""
      },
      {
        "sku": "EM-NRV16",
        "description": "EXPLOSION ISOLATION VALVE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 3312,
        "price_updated_date": ""
      },
      {
        "sku": "CONTROL PANEL",
        "description": "",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 4461.3,
        "price_updated_date": ""
      },
      {
        "sku": "INSTALLATION",
        "description": "QUO-251254-X6W0F9",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 16644.75,
        "price_updated_date": ""
      },
      {
        "sku": "9302601",
        "description": "WEATHER DOME ASSEMBLY, 24 X 34, MEMBREX DCIQ-5BB6A-244616",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 193,
        "price_updated_date": ""
      },
      {
        "sku": "404-09-01-00-00",
        "description": "Dust Level Sensor Ecomaxx",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 339,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "EASTERN METAL SUPPLY",
    "address_lines": [
      "2925 Stewart Creek Blvd",
      "Charlotte, NC 28216"
    ],
    "phone": "704-391-2266",
    "contacts": [
      {
        "name": "Ted Puckett"
      }
    ],
    "send_to_emails": [
      "tpuckett@easternmetal.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "FREIGHT: SHIP VIA ABF FREIGHT account # 189059",
    "standard_notes": "Please ensure that proper packaging is used to PLEASE SEND CONFIRMATION OF ORDER",
    "catalog": [
      {
        "sku": "",
        "description": "Feet Aluminum extrusion / alloy: 6063-T6 \"DIVIDER BAR\" 12' LENGTHS MILL FINISH",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 6000,
        "unit_price": 1.04,
        "price_updated_date": "2022-06-08"
      },
      {
        "sku": "",
        "description": "DIE CHARGE Drawing #TMP-2876",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 2850,
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "SAMPLE CHARGE (Deliver to WhisperRoom, Inc., attn: Josh Fletcher) (116 S. Sugar Hollow Rd., Morristown, TN 37813)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 500,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "FAIRWAY FASTENERS, INC.",
    "address_lines": [
      "518 Hankes Ave.",
      "Aurora, IL 60505"
    ],
    "phone": "630-393-9242",
    "contacts": [
      {
        "name": "Brad"
      }
    ],
    "send_to_emails": [
      "brad@fairwayfasteners.com",
      "angelica@fairwayfasteners.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "On all orders not shipping UPS Ground, please ship ABF Freight - COLLECT",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "",
        "description": "Square / Phillips Drive Pancake Head Full Thread UPDATED 6/8/2022 Stainless Steel Machine Screw 18-8 Black Oxide Head OD: .650 Head Thickness: .116\" - 126\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30000,
        "unit_price": 0.55,
        "price_updated_date": "2020-01-04"
      },
      {
        "sku": "",
        "description": "Phillip Oval 18-8 Stainless Steel Machine Screw UPDATED 4/7/2021 With Black Oxide finish",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30000,
        "unit_price": 0.089,
        "price_updated_date": "2020-01-04"
      },
      {
        "sku": "1412MPT188",
        "description": "Phillip Truss Head 18-8 Stainless Steel Machine Screw UPDATED 3/4/2022 Standard Finish",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2500,
        "unit_price": 0.118,
        "price_updated_date": "2020-01-04"
      },
      {
        "sku": "",
        "description": "#5 x 1/2\" Wood Screw, Zinc-Plated #5 x 1/2\" Flat Head, Phillips Drive",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2000,
        "unit_price": 0.012,
        "price_updated_date": "2019-06-25"
      },
      {
        "sku": "",
        "description": "6-32 x 7/8\" Machine Screw, Zinc-Plated 6/32 x 7/8\" Pan Head, Phillips Drive",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2000,
        "unit_price": 0.013,
        "price_updated_date": "2019-06-25"
      },
      {
        "sku": "",
        "description": "1/4-20 x 3 1/2\" UPDATED 6/25/2019 Oval Head, Phillips Drive",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1000,
        "unit_price": 0.195,
        "price_updated_date": "2020-01-04"
      },
      {
        "sku": "1420MPT188",
        "description": "Phillip Truss Head 18-8 Stainless Steel Machine Screw UPDATED10/17/2017 With standard finish",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10000,
        "unit_price": 0.1,
        "price_updated_date": "2020-01-04"
      }
    ]
  },
  {
    "name": "GUARDIAN FABRICATION, LLC",
    "address_lines": [
      "110 Jack Guynn Drive",
      "Galax, VA 24333"
    ],
    "phone": "",
    "contacts": [
      {
        "name": "Lynette Robinson"
      }
    ],
    "send_to_emails": [
      "lrobinson@guardian.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "*** NOTE: PLEASE REPLY WITH CONFIRMATION AND ESTIMATED SHIP DATE. ***",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "1230",
        "description": "12\" x 30\" Insulated Glass Unit EA 12.0 30.0 130.75 5.0 250.0 minimum 5 square foot pricing",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 130.75,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "1630",
        "description": "16\" x 30\" Insulated Glass Unit EA 16.0 30.0 130.75 6.666666666666667 333.33333333333337 minimum 5 square foot pricing",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 130.75,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "1648",
        "description": "16\" x 48\" Insulated Glass Unit EA 16.0 48.0 139.46666666666664 10.666666666666666 533.3333333333333",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 139.4667,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "2630",
        "description": "26\" x 30\" Insulated Glass Unit EA 26.0 30.0 141.64583333333334 10.833333333333334 216.66666666666669",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 141.6458,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "2636",
        "description": "26\" x 36\" Insulated Glass Unit EA 26.0 36.0 169.975 13.0 520.0",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 169.975,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "2642",
        "description": "26\" x 42\" Insulated Glass Unit EA 26.0 42.0 198.30416666666665 15.166666666666666 303.3333333333333",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 198.3042,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "2648",
        "description": "26\" x 48\" Insulated Glass Unit EA 26.0 48.0 226.6333333333333 17.333333333333332 173.33333333333331",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 226.6333,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "3230",
        "description": "32\" x 30\" Insulated Glass Unit EA 32.0 30.0 174.33333333333334 13.333333333333334 266.6666666666667",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 174.3333,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "3236",
        "description": "32\" x 36\" Insulated Glass Unit EA 32.0 36.0 209.2 16.0 640.0",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 209.2,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "3242",
        "description": "32\" x 42\" Insulated Glass Unit EA 32.0 42.0 244.06666666666666 18.666666666666668 373.33333333333337",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 244.0667,
        "price_updated_date": "2025-11-25"
      },
      {
        "sku": "3248",
        "description": "32\" x 48\" Insulated Glass Unit EA 32.0 48.0 278.9333333333333 21.333333333333332 213.33333333333331 3823.3333333333335",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 278.9333,
        "price_updated_date": "2025-11-25"
      }
    ]
  },
  {
    "name": "Granat Industries, Inc.",
    "address_lines": [
      "875 Nicholas Blvd.",
      "Elk Grove Village, IL 60007",
      "SHIP"
    ],
    "phone": "(847) 690-9394",
    "contacts": [
      {
        "name": "Matthew Baumer"
      }
    ],
    "send_to_emails": [
      "matthew@granatindustries.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "Ship as three separate parts as specified below.",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER. IMPORTANT: Please ensure that strap lengths and hole locations are accurate. PLEASE ENSURE THAT MELTED HOLES ARE CENTERED !",
    "catalog": [
      {
        "sku": "",
        "description": "lyds PS1BHKV 1\" BLACK VELCRO BRAND PS HOOK",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1000,
        "unit_price": 1.6,
        "price_updated_date": "2022-07-25"
      },
      {
        "sku": "",
        "description": "lyds 1\" BLACK BACK-TO-BACK VELCRO 'HOOK 18208",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 800,
        "unit_price": 3.2,
        "price_updated_date": "2026-04-08"
      }
    ]
  },
  {
    "name": "IndFas Supply - TN",
    "address_lines": [
      "2490 Hwy 25E",
      "PO Box 114",
      "Tazewell, TN 37879"
    ],
    "phone": "423-201-4700",
    "contacts": [
      {
        "name": "Steve Bailey"
      }
    ],
    "send_to_emails": [
      "steve@indfassupply.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "ISMRR 1 3/4",
        "description": "ROLL STAPLES FOR BOX STAPLER cases (24 coils / case)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 3,
        "unit_price": 145.09,
        "price_updated_date": "2021-08-10"
      },
      {
        "sku": "90/32 HARDENED 1 1/4\" STAPLES",
        "description": "boxes (5,000 staples / BOX) (6 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 24,
        "unit_price": 28.94,
        "price_updated_date": "2026-01-28"
      },
      {
        "sku": "EZFIT B4424",
        "description": "3/4 INCH D F PINS boxes (5,000 PINS / BOX) (20 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 7.98,
        "price_updated_date": "2021-08-10"
      },
      {
        "sku": "EZFIT B4440",
        "description": "1 1/4 INCH D F PINS boxes (5,000 PINS / BOX) (10 BOXES / CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30,
        "unit_price": 10.37,
        "price_updated_date": "2021-08-10"
      },
      {
        "sku": "EZFIT 1816",
        "description": "1/2\" 18 gauge Brads boxes (5000 PINS / BOX)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 7.52,
        "price_updated_date": "2021-08-10"
      },
      {
        "sku": "403720",
        "description": "LUBRICATING OIL bottles",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 5.99,
        "price_updated_date": "2021-08-10"
      },
      {
        "sku": "FN1850D-CT",
        "description": "BRAD NAIL GUN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 176.73,
        "price_updated_date": "2025-10-16"
      }
    ]
  },
  {
    "name": "INDUSTRIAL ELECTRONICS",
    "address_lines": [
      "10334 Cogdill Rd.",
      "Knoxville, TN 37932",
      "PO#"
    ],
    "phone": "865-777-0099",
    "contacts": [
      {
        "name": "Sara Fanta"
      }
    ],
    "send_to_emails": [
      "sfanta@ieknox.com",
      "djohnson@ieknox.com",
      "tfranklin@ieknox.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "CA055R",
        "description": "NICKEL-PLATED RCA PANEL MOUNT JACK - RED each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 25,
        "unit_price": 0.34,
        "price_updated_date": "2017-09-12"
      },
      {
        "sku": "CA055B",
        "description": "NICKEL-PLATED RCA PANEL MOUNT JACK - BLACK each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 25,
        "unit_price": 0.33,
        "price_updated_date": "2017-09-12"
      },
      {
        "sku": "MJP",
        "description": "MULTI JACK PANEL each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 48,
        "unit_price": 479.97,
        "price_updated_date": ""
      },
      {
        "sku": "MJP",
        "description": "MULTI-JACK PANEL (with Gino connector) each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 669.48,
        "price_updated_date": "2023-02-02"
      },
      {
        "sku": "MJP",
        "description": "MULTI-JACK PANEL (with Gino connector) each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 723.86,
        "price_updated_date": "2025-07-30"
      },
      {
        "sku": "MJP-X",
        "description": "MULTI-JACK PANEL (with Gino connector) each 6' ADDITIONAL CABLE LEGNTH",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 512.17,
        "price_updated_date": "2018-12-03"
      },
      {
        "sku": "7225MFSTEXT",
        "description": "6 ft \" MALE PLUG - \" FEMALE JACK each",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 3.48,
        "price_updated_date": "2018-05-07"
      }
    ]
  },
  {
    "name": "INDEX FASTENERS",
    "address_lines": [
      "945 Grevillea Court",
      "Ontario, California 91761"
    ],
    "phone": "909-923-5002",
    "contacts": [
      {
        "name": "Justin Quinones"
      }
    ],
    "send_to_emails": [
      "jquinones@indexfasteners.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "PC 47560",
        "description": "RATCHET FASTENERS - BLACK Bag of 1000 (.187 dia hole / .480 lg / .437 hd)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5,
        "unit_price": 78.9,
        "price_updated_date": "2015-04-20"
      },
      {
        "sku": "PC 47611",
        "description": "RATCHET FASTENERS - BLACK Bag of 1000 (.187 dia hole / .375 lg / .75 hd)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 100,
        "price_updated_date": "2018-10-11"
      }
    ]
  },
  {
    "name": "KEYMATE, INC.",
    "address_lines": [
      "1278A Surfside Industrial Park",
      "Surfside Beach, SC 29575"
    ],
    "phone": "(843) 238-1420",
    "contacts": [
      {
        "name": "Mr. Mike Chaky"
      }
    ],
    "send_to_emails": [
      "keymate@sccoast.net"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE FAX CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "DJ 9450-CP",
        "description": "ADJ-A-STK 2 - 3/4\" CR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 400,
        "unit_price": 4.96,
        "price_updated_date": "2023-11-08"
      }
    ]
  },
  {
    "name": "LAKEWAY CONTAINER, INC.",
    "address_lines": [
      "5715 Superior Dr.",
      "Morristown, TN 37814"
    ],
    "phone": "423-581-2164",
    "contacts": [
      {
        "name": "Arnold Anderson"
      }
    ],
    "send_to_emails": [
      "arnold@lakewaycontainer.com",
      "rose@lakewaycontainer.com",
      "robin@lakewaycontainer.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "",
        "description": "STD WL 40 170011 U - C / P - G 82 1/4\" x 2 1/2\" x 41 1/2\" GLUE IN 2P-1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 250,
        "unit_price": 8.536,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD SS CNR 170006 U - C / P - G 82 1/4\" x 4 1/4\" x 19 GLUE IN 2P-1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 400,
        "unit_price": 4.59,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD SS MID 170007 U - C / P - G 82 1/4\" x 2 1/2\" x 13 7/8\" GLUE IN 2P-1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 400,
        "unit_price": 3.429,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "FOAM 170005 U - C / P - G 49\" x 5\" x 25\" GLUE IN 2P-1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 3.248,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "VENT SET BTM 170001 TEL NONE 52 1/2\" x 14\" x 7\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 600,
        "unit_price": 1.551,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "VENT SET TOP 170002 TEL NONE 53 1/8\" x 14 5/8\" x 7\" 1P - 1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 600,
        "unit_price": 1.59,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD WL 46 170012 FOL GLUE IN 2P-1C 82 1/4\" x 2 1/2\" x 47 1/2\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 8.874,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD DRFRM 46 170014 FOL GLUE IN 2P-1C 82 1/4\" x 3 1/8\" x 47 1/2\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 8.238,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD DOOR 46 170013 U - C / P - G 76 1/2\" x 3 1/8\" x 30 3/4\" GLUE IN 2P-1C 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 5.526,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD DRFRM 170016 FOL GLUE IN 2P-1C 82 1/4\" x 3 1/8\" x 41 1/2\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 450,
        "unit_price": 5.825,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STD DOOR 170015 FOL GLUE IN 2P-1C 76 1/2\" x 3 1/8\" x 24 3/4\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 450,
        "unit_price": 3.779,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STYRO STRIP 170010 SHEET NONE 96\" x 3/4\" x 2\" PLAIN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 300,
        "unit_price": 0.867,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STYRO BLOCK 170008 SHEET NONE 19\" x 4\" x 2 7/8\" PLAIN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 300,
        "unit_price": 1.218,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "STYRO BLOCK WA 170009 SHEET NONE 30\" x 4\" x 2 7/8\" PLAIN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 300,
        "unit_price": 1.686,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "SL 29 170003 1PF NONE 1P-1C 33 1/2\" x 2\" x 11 1/2\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 400,
        "unit_price": 2.092,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "SL 52 170004 1PF NONE 1P-1C 56 3/4\" x 2\" x 11 1/2\" 32 C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 3.224,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "10242 CP 170017 FOL 2 PC / GL 105 1/4\" x 3\" x 44 1/4\" 2P - 1C 32C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 9.971,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "9648 FL / CL 170018 FOL 2 PC / GL 97 1/4\" x 3\" x 49 1/4\" 2P - 1C 32C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 320,
        "unit_price": 8.934,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "RAMP 1 170019 RSC GLUE IN 47\" x 9 1/2\" x 4 32C",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 265,
        "unit_price": 1.9,
        "price_updated_date": "2025-04-10"
      },
      {
        "sku": "",
        "description": "9648 CP 170020 FOL 2 PC / GL 99 1/4\" x 3\" x 51 1/4\" 2P - 1C 32C LABELS (stamped front and back) *** NOTE: PLEASE SEND CONFIRMATION OF ORDER WITH UPDATED PRICES. *** Sincerely, Josh Fletcher JOSH FLETCHER",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 125,
        "unit_price": 10.062,
        "price_updated_date": "2026-05-21"
      }
    ]
  },
  {
    "name": "Merit Supply, Inc.",
    "address_lines": [
      "1310 Union Street",
      "Spartanburg, SC 29302"
    ],
    "phone": "(800) 726-5639",
    "contacts": [],
    "send_to_emails": [
      "meritsupplyorders@lancasterco.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "MD # 43374-78105",
        "description": "UNITS STAIR EDGING A726F MF 72\" EACH",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 162,
        "unit_price": 9.26,
        "price_updated_date": "2025-08-06"
      },
      {
        "sku": "MD # 43374-05991",
        "description": "UNITS BOTTOM DOOR SEAL EACH U-SHAPE, SCREW-ON, BROWN",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 96,
        "unit_price": 10.74,
        "price_updated_date": "2021-08-24"
      }
    ]
  },
  {
    "name": "MetalPhoto of Cincinnati",
    "address_lines": [
      "1080 Skillman Drive",
      "Cincinnati, OH 45215"
    ],
    "phone": "513-772-8281",
    "contacts": [
      {
        "name": "Tom Petre"
      }
    ],
    "send_to_emails": [
      "tpetre@mpofcinci.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "PN79365",
        "description": "WHISPER ROOM LOGO PLATE 5.625\" x 1.600\" Satin Finish, Black Graphics Natural aluminum background 3M 468 adhesive Radius corners (.437\")",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 2.72,
        "price_updated_date": "2024-09-18"
      },
      {
        "sku": "PM82911",
        "description": "Fired Rated NP 3.00\" x .847\" Satin Finish, Black Graphics Natural aluminum background 3M 468 adhesive Radius corners (.125\")",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 350,
        "unit_price": 1.35,
        "price_updated_date": "2017-12-13"
      }
    ]
  },
  {
    "name": "MULTI-WALL PACKAGING CORP.",
    "address_lines": [
      "Martinsville, VA 24112"
    ],
    "phone": "276-666-2222",
    "contacts": [
      {
        "name": "Alicia Likens"
      }
    ],
    "send_to_emails": [
      "alikens@signode.com"
    ],
    "cc_emails": [],
    "payment_terms": "PURCHASE ORDER TERMS: 1% 10 Net 30.",
    "freight_terms": "SHIP COLLECT VIA OLD DOMINION",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "005822-00",
        "description": "U200-3-C 12\" CHANNEL CORNER 12.00 X 1.00 X 2.00 IN 48\" STRIP 1\" WIDE #641964",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 3360,
        "unit_price": 1.6147,
        "price_updated_date": "2025-09-02"
      },
      {
        "sku": "006093-00",
        "description": "U200-3-C 12\" CHANNEL CORNER 12.00 X 1.75 X 2.00 IN 48\" STRIP 1 3/4\" WIDE #114489",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2304,
        "unit_price": 1.712,
        "price_updated_date": "2025-09-02"
      },
      {
        "sku": "006584-00",
        "description": "FP - 3-C 48\" X 48\" FLAT PAD 48.00 X 48.00",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 20.9297,
        "price_updated_date": "2026-04-27"
      }
    ]
  },
  {
    "name": "Norco Metal Finishing, Inc.",
    "address_lines": [
      "1536 Island Home Ave.",
      "Knoxville, TN 37920",
      "(800) 653-5038",
      "(865) 577-1648"
    ],
    "phone": "",
    "contacts": [
      {
        "name": "Jerry Norton"
      }
    ],
    "send_to_emails": [
      "jerry1@norcometalinc.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "Please ensure that proper packaging is used to prevent PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "",
        "description": "pieces BLACK ANNODIZING",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 8.5,
        "price_updated_date": "2025-07-02"
      }
    ]
  },
  {
    "name": "Orange Aluminum Corporation",
    "address_lines": [
      "13111 Meyer Rd",
      "Whittier CA 90605",
      "Nicole Langlois"
    ],
    "phone": "877-464-2181",
    "contacts": [],
    "send_to_emails": [
      "nlanglois@orangealuminum.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "",
    "catalog": [
      {
        "sku": "Door Strip A",
        "description": "1.750 x 1.000 x .125 Unequal Angle T2552 38.75\" Cut Length (+/-.032) 6063-T5 Mill Finish Hole Fabrication per Drawing \"Door Strip A\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 26.69,
        "price_updated_date": "2024-04-05"
      },
      {
        "sku": "Door Strip B",
        "description": "ORAUA6310001750125-38.75MH-B 1.750 x 1.000 x .125 Unequal Angle T2552 38.75\" Cut Length (+/-.032) 6063-T5 Mill Finish Hole Fabrication per Drawing \"Door Strip B\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 17.58,
        "price_updated_date": "2023-11-21"
      },
      {
        "sku": "Door Strip 40",
        "description": "1.750 x 1.000 x .125 Unequal Angle T2552 27.75\" Cut Length (+/-.032) 6063-T5 Mill Finish Hole Fabrication per Drawing \"Door Strip 40\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 14.16,
        "price_updated_date": "2025-03-05"
      },
      {
        "sku": "Door Strip 46",
        "description": "1.750 x 1.000 x .125 Unequal Angle T2552 33.75\" Cut Length (+/-.032) 6063-T5 Mill Finish Hole Fabrication per Drawing \"Door Strip 46\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 450,
        "unit_price": 16.82,
        "price_updated_date": "2026-05-26"
      },
      {
        "sku": "EDGE TRIM STRIP",
        "description": "HLET63813-72BDH Heavy Lip Edge Trim, Covers 13/16\", Brite-Dip Anodized, w/holes Per #QUO8513",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 275,
        "unit_price": 9.54,
        "price_updated_date": "2024-04-23"
      }
    ]
  },
  {
    "name": "PENN ELCOM",
    "address_lines": [
      "230 West Parkway, Unit # 6",
      "Pompton Plains, NJ 07444"
    ],
    "phone": "800-446-7174",
    "contacts": [],
    "send_to_emails": [
      "Leland.Pippin@penn-elcom.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "M1703",
        "description": "4\" x 4 1/2\" PORT TUBE (BLACK)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1000,
        "unit_price": 1.043,
        "price_updated_date": "2025-03-31"
      },
      {
        "sku": "G0726",
        "description": "PLASTIC CLAMP (BLACK)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1200,
        "unit_price": 0.11,
        "price_updated_date": "2021-01-27"
      }
    ]
  },
  {
    "name": "Pennex Aluminum",
    "address_lines": [
      "20 Community Street",
      "Wellsville, PA 17365"
    ],
    "phone": "717-432-9647",
    "contacts": [
      {
        "name": "Hayat Ellaouni"
      },
      {
        "name": "Tammy Davis"
      }
    ],
    "send_to_emails": [
      "hellaouni@pennexaluminum.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "FREIGHT: SHIP VIA ABF FREIGHT account # 189059",
    "standard_notes": "Please ensure that proper packaging is used to PLEASE SEND CONFIRMATION OF ORDER",
    "catalog": [
      {
        "sku": "",
        "description": "lbs Aluminum extrusion / alloy: 6063-T6 Extrusion # 030402 DWG. #ARG - 18150 x 12 ft. Approximately 6000 feet (500 pieces)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1573,
        "unit_price": 3.003,
        "price_updated_date": "2025-06-26"
      }
    ]
  },
  {
    "name": "Phelan & Associates, Inc.",
    "address_lines": [
      "5720 Cloverhill Drive",
      "Brentwood, TN 37027"
    ],
    "phone": "(615) 373-0908",
    "contacts": [
      {
        "name": "Sean Phelan"
      }
    ],
    "send_to_emails": [
      "sphelanrep@outlook.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "Hinge",
        "description": "units 920 , 4 1/2\" x 4 1/2\", /unit RIGHT HANDED, US26D , Dull Chrome (TWO KNUCKLE) HAGER",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 240,
        "unit_price": 13.3224,
        "price_updated_date": "2026-05-28"
      },
      {
        "sku": "Hinge",
        "description": "units 920 , 4 1/2\" x 4 1/2\", /unit LEFT HANDED, US26D , Dull Chrome (TWO KNUCKLE) HAGER",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 240,
        "unit_price": 13.3224,
        "price_updated_date": "2026-05-28"
      },
      {
        "sku": "920 HINGE",
        "description": "units 4 1/2\" x 4 1/2\", /unit RIGHT HANDED, USP, PRIMED (TWO KNUCKLE) PLAIN BEARING",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 240,
        "unit_price": 5.46,
        "price_updated_date": "2021-01-07"
      },
      {
        "sku": "920 HINGE",
        "description": "units 4 1/2\" x 4 1/2\", /unit LEFT HANDED, USP, PRIMED (TWO KNUCKLE) PLAIN BEARING",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 240,
        "unit_price": 5.46,
        "price_updated_date": "2021-01-07"
      },
      {
        "sku": "Tariff Surcharge",
        "description": "",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": "",
        "unit_price": 0.0875,
        "price_updated_date": ""
      }
    ]
  },
  {
    "name": "Piedmont Plastics",
    "address_lines": [
      "2567 Prime Way Dr.",
      "Ste. 102",
      "Knoxville, TN 37918"
    ],
    "phone": "(865) 281-8383",
    "contacts": [
      {
        "name": "Kevin O'Connor"
      }
    ],
    "send_to_emails": [
      "koconnor@piedmontplastics.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE ENSURE MATERIAL IS CUT CLEANLY AND SQUARELY. PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "",
        "description": "ACR 7328 0.708CTM (Seq#: 159095) .708X48X96 7328 WHT ACR CT PM2",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 524,
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "ABS BLK 0.250HC *.250 X 48 X 96 BLACK ABS HAIRCEL 1-SIDE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 91.5,
        "price_updated_date": "2023-11-28"
      },
      {
        "sku": "",
        "description": "ABS BLK 0.125HC *.125 X 48 X 96 BLACK ABS HAIRCEL 1-SIDE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 30,
        "unit_price": 36,
        "price_updated_date": "2019-06-17"
      },
      {
        "sku": "AJP-10 ABS",
        "description": "AUDIO JACK PANEL (10 HOLE) ABS PLASTIC (QUOTE# Q26762009)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 48,
        "unit_price": 9.5,
        "price_updated_date": ""
      },
      {
        "sku": "AJP-6 ABS",
        "description": "AUDIO JACK PANEL (6 HOLE) ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 48,
        "unit_price": 9.5,
        "price_updated_date": ""
      },
      {
        "sku": "XLR MALE",
        "description": "AUDIO JACK PANEL (XLR MALE) ABS PLASTIC (QUOTE# Q26762679)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 24,
        "unit_price": 11.5,
        "price_updated_date": ""
      },
      {
        "sku": "XLR FEMALE",
        "description": "AUDIO JACK PANEL (XLR FEMALE) ABS PLASTIC (QUOTE# Q26762679)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 24,
        "unit_price": 11.5,
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "SPLINE TOOL WHEEL SOLID FABRICATED BLACK DELRIN PART QUOTE #Q26787487",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 11.95,
        "price_updated_date": "2015-02-03"
      },
      {
        "sku": "",
        "description": "SPLINE TOOL WHEEL GROOVED FABRICATED BLACK DELRIN PART QUOTE #Q26787487",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 11.95,
        "price_updated_date": "2015-02-03"
      },
      {
        "sku": "",
        "description": "STUDIO LIGHT COVER 1/8\" ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 7.4,
        "price_updated_date": ""
      },
      {
        "sku": "",
        "description": "VENT DUCT COVER 1/8\" ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 400,
        "unit_price": 7.95,
        "price_updated_date": "2022-02-22"
      },
      {
        "sku": "",
        "description": "VENT BOX FAN COLLAR 1/4\" ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 2.5,
        "price_updated_date": "2015-08-26"
      },
      {
        "sku": "",
        "description": "VSS INTAKE 1/4\" ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 7.85,
        "price_updated_date": "2022-06-13"
      },
      {
        "sku": "",
        "description": "VSS EXHAUST 1/4\" ABS PLASTIC",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 7.85,
        "price_updated_date": "2022-06-13"
      },
      {
        "sku": "PIE-KN-",
        "description": "FLOOR PLASTIC 44734.0 1/4 ABS HOLES 5/16",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 450,
        "unit_price": 2.86,
        "price_updated_date": "2015-12-09"
      },
      {
        "sku": "",
        "description": "RM DUCT COVER Q30223296 1/8\" ABS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 200,
        "unit_price": 6.25,
        "price_updated_date": "2024-02-14"
      },
      {
        "sku": "",
        "description": "ABSCWHT 0.118HCU (Seq#: 351888) 45545.0 .118X48X96 WHT ABS H/C 1 UTIL COB-180095",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 5,
        "unit_price": 52,
        "price_updated_date": "2024-02-14"
      },
      {
        "sku": "",
        "description": "ATP FEET Q30223296 1/4\" ABS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 4.33,
        "price_updated_date": "2022-02-22"
      },
      {
        "sku": "",
        "description": "BARE DOOR THRESHOLD 1/4\" ABS BLACK Q30240493",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 4.25,
        "price_updated_date": "2018-01-17"
      },
      {
        "sku": "",
        "description": "BARE FLOOR PLASTIC 1/4\" ABS BLACK Q30240493",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 1.35,
        "price_updated_date": "2018-01-17"
      },
      {
        "sku": "230307",
        "description": "ACR CLR 0.220AR1 .220X48X96 CLR AR ONE SIDE ACRYLIC Cut to size 2 pcs 19.938\" x 79.125\" AR 1 side acrylic",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 360,
        "price_updated_date": "2019-07-09"
      },
      {
        "sku": "144609",
        "description": "ACR CLR 0.220PLM .220X48X96 CLR ACR PLAS PM2 Cut to size 2 pcs 19.938\" x 79.125\" NON AR acrylic",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 116,
        "price_updated_date": "2019-07-09"
      }
    ]
  },
  {
    "name": "RUBBERMILL",
    "address_lines": [
      "9897 Old Liberty Rd.",
      "P.O. Box 1329",
      "Liberty, NC 27298"
    ],
    "phone": "336-622-1680",
    "contacts": [
      {
        "name": "Robin Wallen"
      }
    ],
    "send_to_emails": [
      "rwallen@rubbermill.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "C-2731",
        "description": "Laboratory stopper (black) with (2) holes # 9",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 500,
        "unit_price": 0.65,
        "price_updated_date": "2025-11-12"
      },
      {
        "sku": "C-2673",
        "description": "Laboratory stopper (black) (NO center hole) # 15",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 100,
        "unit_price": 5.444,
        "price_updated_date": "2012-01-05"
      },
      {
        "sku": "CLS-09-1H-10B40 Laboratory stopper (black) with (1) hole",
        "description": "# 9",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 125,
        "unit_price": 0.65,
        "price_updated_date": "2020-10-09"
      }
    ]
  },
  {
    "name": "STAFAST Products, Inc.",
    "address_lines": [
      "2426 W. Highway 160",
      "Fort Mill, S.C. 29708",
      "SHIP"
    ],
    "phone": "800-951-1159",
    "contacts": [
      {
        "name": "Cindy McDonald"
      }
    ],
    "send_to_emails": [
      "OrderSC@stafast.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "THREADED INSERT",
        "description": "ASAP 1/4\" - 20 , 3/4\" LENGTH cases /1000 (2500/CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 10,
        "unit_price": 86.44,
        "price_updated_date": "2026-02-11"
      },
      {
        "sku": "THREADED INSERT",
        "description": "ASAP 1/4\" - 20 , 1/2\" (.512\") LENGTH cases /1000 (4000/CASE)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 6,
        "unit_price": 62.72,
        "price_updated_date": "2026-02-11"
      },
      {
        "sku": "R142014 WELD NUTS",
        "description": "ASAP PLAIN STEEL, ROUND BASE carton /1000 (3000/CARTON)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 212.67,
        "price_updated_date": "2016-05-03"
      }
    ]
  },
  {
    "name": "TCH Inc., Foam Division",
    "address_lines": [
      "4325 Warren Ravenna Rd.",
      "Newton Falls, OH 44444"
    ],
    "phone": "877-226-1495",
    "contacts": [],
    "send_to_emails": [
      "johns@tchweb.com",
      "wanda.benitez@tchweb.com",
      "nicholasl@tchweb.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "VENT DUCT FOAM",
        "description": "1.4# Medium gray ETHER foam Dimensions: 3\" x 4 5/8\" x 42\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2116,
        "unit_price": 4.69,
        "price_updated_date": "2022-07-14"
      }
    ]
  },
  {
    "name": "UFP Morristown, LLC",
    "address_lines": [
      "530 West Morris Blvd.",
      "Morristown, TN 37813"
    ],
    "phone": "423-312-3811",
    "contacts": [
      {
        "name": "Kelly McPherson"
      }
    ],
    "send_to_emails": [
      "kellymcpherson@ufpi.com",
      "cfoltz@ufpi.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE ENSURE ALL PALLETS HAVE VISIBLE HT STAMP. PLEASE ENSURE ALL SLATS ARE FASTENED WITH SCRAILS. PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "162980",
        "description": "90\" X 52\" 4-WAY PINE PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 80,
        "unit_price": 124.81,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "163973",
        "description": "90\" X 46.25\" 4-WAY PINE PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 97.81,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "163972",
        "description": "108\" X 46.25\" 4-WAY PINE PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 123.79,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "",
        "description": "102\" X 52\" 4-WAY PINE PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 60,
        "unit_price": 152.85,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "",
        "description": "90\" X 41\" 4-WAY PINE PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 20,
        "unit_price": 88.57,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "69889",
        "description": "90\" X 44\" 4-WAY SYP HT PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 17,
        "unit_price": 105.01,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "103969",
        "description": "100\" X 40\" 4-WAY SYP HT PALLET",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 123.49,
        "price_updated_date": "2021-05-13"
      },
      {
        "sku": "671493",
        "description": "Crate, 99 x 53 x 50.5 SYP HT 4-Way FORT MASON (TINSEL) 96144 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 1012.95,
        "price_updated_date": "2024-08-30"
      },
      {
        "sku": "671491",
        "description": "Crate, 82 x 52 x 50 SYP HT 4-Way FORT MASON (TINSEL) 96144 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 888.95,
        "price_updated_date": "2024-08-30"
      },
      {
        "sku": "671492",
        "description": "Crate, 82 x 48 x 43 SYP HT 4-Way FORT MASON (TINSEL) 96144 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 726.25,
        "price_updated_date": "2024-08-30"
      },
      {
        "sku": "572548",
        "description": "103\" x 40.18\" x 43.25\" CRATE SYP HT NBC 6084 & 10284 (NEW)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 869.71,
        "price_updated_date": "2024-03-04"
      },
      {
        "sku": "572747",
        "description": "82\" x 39.81\" x 41.25\" CRATE, SYP HT NBC 6084 & 10284 (NEW)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 684.23,
        "price_updated_date": "2024-03-04"
      },
      {
        "sku": "237585",
        "description": "56-15/16\" x 83-5/16\" x 45\" CRATE SYP HT NBC 6084 SINGLE",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 687.5,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "244443",
        "description": "31-1/4\" x 103\" x 43-1/4\" CRATE SYP HT NBC 6084 & 10284 COMBINED",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 3,
        "unit_price": 753.5,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "244444",
        "description": "36\" x 82\" x 41-1/4\" CRATE SYP HT NBC 6084 & 10284 COMBINED",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 3,
        "unit_price": 687.5,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "244445",
        "description": "46-1/4\" x 62\" x 43-1/4\" CRATE SYP HT NBC 6084 & 10284 COMBINED",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 3,
        "unit_price": 687.5,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "256507",
        "description": "100\" x 44\" x 54.5\" CRATE SYP HT",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 781,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "",
        "description": "104\" x 59.625\" x 49.25\" CRATE SYP HT PGA TOUR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 8,
        "unit_price": 962.5,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "CRATE #1",
        "description": "52.375\" x 51\" x 82\" CRATE SYP HT FOX SPORTS 4848 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 986.128,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "CRATE #2",
        "description": "41.125\" x 50\" x 98\" CRATE SYP HT FOX SPORTS 96120 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 919.996,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "CRATE #3",
        "description": "49\" x 50\" x 82\" CRATE SYP HT FOX SPORTS 96120 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 987.228,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "CRATE #4",
        "description": "37.75\" x 43\" x 84\" CRATE SYP HT FOX SPORTS 96120 E",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 4,
        "unit_price": 636.98,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "SITKA #1",
        "description": "82 \"x 43.25\" x 43.625\" CRATE SYP HT SITKA",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 650,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "SITKA #2",
        "description": "82\" x 48.5\" x 50.25\" CRATE SYP HT SITKA",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 815,
        "price_updated_date": "2020-09-18"
      },
      {
        "sku": "695030",
        "description": "82\" x 40.5\" x 48.25\" MARSHALL 96192 CRATE A",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 835,
        "price_updated_date": "2025-05-19"
      },
      {
        "sku": "695031",
        "description": "82\" x 35.5\" x 48.25\" MARSHALL 96144 CRATE A",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 835,
        "price_updated_date": "2025-05-19"
      },
      {
        "sku": "695032",
        "description": "97\" x 46.75\" x 50.25\" MARSHALL 96192 CRATE B",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 965,
        "price_updated_date": "2025-05-19"
      },
      {
        "sku": "695033",
        "description": "97\" x 39.5\" x 50.25\" MARSHALL 96144 CRATE B",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 2,
        "unit_price": 1150,
        "price_updated_date": "2025-05-19"
      },
      {
        "sku": "719085",
        "description": "87\" x 45.875\" x 50.5\" SYP HT NMR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 1126.45,
        "price_updated_date": "2026-02-12"
      },
      {
        "sku": "719086",
        "description": "82\" x 45.875\" x 41.5\" SYP HT NMR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 724.85,
        "price_updated_date": "2026-02-12"
      },
      {
        "sku": "719087",
        "description": "82\" x 42.875\" x 37\" SYP HT NMR",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 1,
        "unit_price": 721.97,
        "price_updated_date": "2026-02-12"
      }
    ]
  },
  {
    "name": "WILREP Ltd.",
    "address_lines": [
      "1515 Matheson Blvd. East Unit C-10",
      "Mississauga, Ontario Canada L4W 2P5"
    ],
    "phone": "(905) 625-8944",
    "contacts": [
      {
        "name": "Bill Wilkinson Jr."
      },
      {
        "name": "Don Wilkinson"
      }
    ],
    "send_to_emails": [
      "mary@wilrep.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "*** NOTE: PLEASE SHIP VIA - ABF - COLLECT. ***",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "Duracoustic",
        "description": "SOUND CONTROL UNDERLAYMENT (54\" x 24' PER ROLL)",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 50,
        "unit_price": 138.19,
        "price_updated_date": "2022-11-03"
      }
    ]
  },
  {
    "name": "WOODCRAFT",
    "address_lines": [
      "105 S. Austin Rd",
      "MORRISTOWN, TN 37813",
      "Tim Elliott or Jody Greene"
    ],
    "phone": "423-581-5413",
    "contacts": [],
    "send_to_emails": [
      "tim@woodcraftinc.net",
      "jody@woodcraftinc.net"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "",
        "description": "31 x 15 x 3/4\" RED OAK BOARDS",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 16.8,
        "price_updated_date": "2021-03-29"
      },
      {
        "sku": "",
        "description": "43 x 17 x 3/4\" RED OAK BOARDS Call or email when order is complete and WhisperRoom will come and pickup.",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 40,
        "unit_price": 27,
        "price_updated_date": "2023-11-27"
      }
    ]
  },
  {
    "name": "Wurth Wood Group",
    "address_lines": [
      "234 Direct Connection Dr.",
      "Rossville, GA 30741"
    ],
    "phone": "423-618-0338 (cell)",
    "contacts": [
      {
        "name": "Dennis"
      }
    ],
    "send_to_emails": [
      "DBenedict@wurthwoodgroup.com"
    ],
    "cc_emails": [],
    "payment_terms": "",
    "freight_terms": "",
    "standard_notes": "PLEASE SEND CONFIRMATION OF ORDER.",
    "catalog": [
      {
        "sku": "3448MDFD",
        "description": "\"DOOR GRADE\" MDF 49 X 97 X 3/4\"",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 231,
        "unit_price": 38.82,
        "price_updated_date": "2026-05-08"
      },
      {
        "sku": "5067",
        "description": "TITEBOND ORIGINAL YELLOW WOOD GLUE 5 GALLON PAIL",
        "mfg": "",
        "mfg_part_no": "",
        "default_qty": 6,
        "unit_price": 87.7,
        "price_updated_date": "2026-04-13"
      }
    ]
  },
  {
    "name": "AJ Nonwovens-Hampton (Foss)",
    "address_lines": [
      "11 Merrill Industrial Drive",
      "Hampton, NH"
    ],
    "phone": "603-929-6116",
    "contacts": [
      {
        "name": "Jack Beehler"
      }
    ],
    "send_to_emails": [
      "jack.beehler@ajnw.com"
    ],
    "cc_emails": [],
    "payment_terms": "1%10, Net 30",
    "freight_terms": "",
    "billing_address_override": "WhisperRoom, Inc. 322 Nancy Lynn Lane, Suite 14 Knoxville, TN 37919 Attn: Accounting 800-200-8138",
    "standard_notes": "Ensure that color is consistent with previous shipments. Call with dimensions prior to shipping. Hold shipment until instructions received.",
    "catalog": [
      {
        "sku": "6A46A22X050P",
        "description": "Gray Tweed Duralock — 48\" wide (price per LYD)",
        "mfg": "Foss",
        "mfg_part_no": "6A46A22X050P",
        "default_qty": 6000,
        "unit_price": 4.14,
        "price_updated_date": "2022-04-14"
      },
      {
        "sku": "6A46A22X062P",
        "description": "Gray Tweed Duralock — 60\" wide (price per LYD)",
        "mfg": "Foss",
        "mfg_part_no": "6A46A22X062P",
        "default_qty": 5000,
        "unit_price": 6.55,
        "price_updated_date": "2022-04-14"
      },
      {
        "sku": "CN15N470072",
        "description": "Belize Gunmetal — 72\" wide (price per LYD)",
        "mfg": "Foss",
        "mfg_part_no": "CN15N470072",
        "default_qty": 4000,
        "unit_price": 7.61,
        "price_updated_date": "2021-05-19"
      },
      {
        "sku": "",
        "description": "Elevations II — 48\" wide (price per LYD)",
        "mfg": "Foss",
        "mfg_part_no": "",
        "default_qty": 4000,
        "unit_price": 5.1,
        "price_updated_date": "2021-05-19"
      }
    ]
  }
];
  const opts = { credentials: 'include', headers: { 'Content-Type': 'application/json' } };
  const listRes = await fetch('/api/vendors?archived=1', opts);
  const listJson = await listRes.json();
  if (!listRes.ok) { console.error('Failed to list vendors:', listJson); return; }
  const existing = new Map((listJson.vendors || []).map(v => [v.name, v]));
  let created = 0, updated = 0, failed = 0;
  for (const v of VENDORS) {
    try {
      const cur = existing.get(v.name);
      let r, action;
      if (cur) { action = 'PATCH'; r = await fetch('/api/vendors/' + cur.id, { ...opts, method: 'PATCH', body: JSON.stringify(v) }); }
      else     { action = 'POST';  r = await fetch('/api/vendors', { ...opts, method: 'POST', body: JSON.stringify(v) }); }
      const j = await r.json();
      if (!r.ok) { failed++; console.error('\u2717 ' + v.name + ' (' + action + '):', j); continue; }
      if (action === 'POST') { created++; console.log('\u2713 Created ' + v.name + ' (' + v.catalog.length + ' items)'); }
      else                   { updated++; console.log('\u2713 Updated ' + v.name + ' (' + v.catalog.length + ' items)'); }
    } catch(e) { failed++; console.error('\u2717 ' + v.name + ':', e.message); }
  }
  console.log('Done \u2014 created ' + created + ', updated ' + updated + ', failed ' + failed + '. Refresh /vendors.');
})();
