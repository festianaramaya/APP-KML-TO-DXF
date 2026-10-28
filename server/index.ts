// ==========================================
// 1. IMPORT MODUL LENGKAP & RUNTIME BACKEND
// ==========================================
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import { XMLParser } from "fast-xml-parser";
import * as turf from "@turf/turf";
import polygonClipping from "polygon-clipping";
// @ts-ignore
import Drawing from "dxf-writer";

// ==========================================
// 2. TIPE DATA & KONSTANTA GLOBAL
// ==========================================
export type PlacemarkCategory =
  | "fdt"
  | "fat"
  | "existing_pole"
  | "new_pole"
  | "joint_closure"
  | "slack_hanger"
  | "cable"
  | "cable_subfeeder"
  | "sling_wire"
  | "fat_boundary"
  | "boundary_cluster"
  | "homepass"
  | "homepass_cover"
  | "homepass_uncover"
  | "default";

export interface MitraCResult {
  [key: string]: any;
}

const KML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseNodeValue: false,
};

// Class MTextEntity yang valid untuk dxf-writer (dikembalikan persis seperti aslinya)
class MTextEntity {
  x: number;
  y: number;
  height: number;
  text: string;
  attachmentPoint: number;
  lineSpacingFactor: number;

  constructor(
    x: number,
    y: number,
    height: number,
    text: string,
    attachmentPoint = 1,
    lineSpacingFactor = 1.0,
    _layerName?: string
  ) {
    this.x = x;
    this.y = y;
    this.height = height;
    this.text = text;
    this.attachmentPoint = attachmentPoint;
    this.lineSpacingFactor = lineSpacingFactor;
  }

  tags(manager: any) {
    manager.push(0, "MTEXT");
    manager.push(10, this.x);
    manager.push(20, this.y);
    manager.push(30, 0.0);
    manager.push(40, this.height);
    manager.push(71, this.attachmentPoint);
    manager.push(44, this.lineSpacingFactor);
    manager.push(1, this.text);
  }

  toDxfString(): string {
    let s = `0\nMTEXT\n`;
    s += `10\n${this.x.toFixed(4)}\n`;
    s += `20\n${this.y.toFixed(4)}\n`;
    s += `30\n0.0\n`;
    s += `40\n${this.height.toFixed(4)}\n`;
    s += `71\n${this.attachmentPoint}\n`;
    s += `44\n${this.lineSpacingFactor.toFixed(2)}\n`;
    s += `1\n${this.text}\n`;
    return s;
  }
}

const joinMText = (lines: string[]): string => {
  return lines.join("\\P");
};

const sanitizeDxfOutput = (dxf: string): { dxf: string; fixed: number } => {
  let fixed = 0;
  const cleaned = dxf.replace(/(\b(?:10|20|30|40|50)\n)(NaN|-?Infinity)/g, (_m, p1) => {
    fixed++;
    return `${p1}0.0`;
  });
  return { dxf: cleaned, fixed };
};

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

const rotateOffset = (
  dx: number,
  dy: number,
  rotationDeg: number
): { x: number; y: number } => {
  const rad = toRad(rotationDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  };
};

const parseFloatVal = (val: any): number | null => {
  if (val === null || val === undefined) return null;
  const num = parseFloat(String(val).trim());
  return isNaN(num) ? null : num;
};

const sanitizeDxfText = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/[\\^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const getPlacemarkName = (placemark: any): string => {
  if (!placemark) return "Unnamed";
  if (typeof placemark.name === "string") return placemark.name.trim();
  if (placemark.name && typeof placemark.name["#text"] === "string") {
    return placemark.name["#text"].trim();
  }
  return "Unnamed";
};

const collectGeometries = (placemark: any): { kind: string; coordinates: string }[] => {
  const geoms: { kind: string; coordinates: string }[] = [];
  if (!placemark) return geoms;

  const pushGeom = (obj: any, kind: string) => {
    if (!obj) return;
    const coords = obj.coordinates;
    const coordStr = typeof coords === "object" && coords !== null ? coords["#text"] || "" : coords;
    if (coordStr && typeof coordStr === "string") {
      geoms.push({ kind, coordinates: coordStr.trim() });
    }
  };

  if (placemark.Point) pushGeom(placemark.Point, "Point");
  if (placemark.LineString) pushGeom(placemark.LineString, "LineString");
  if (placemark.Polygon) {
    const poly = placemark.Polygon;
    const boundary = poly.outerBoundaryIs || poly.innerBoundaryIs;
    if (boundary && boundary.LinearRing) {
      pushGeom(boundary.LinearRing, "Polygon");
    } else {
      pushGeom(poly, "Polygon");
    }
  }

  if (placemark.MultiGeometry) {
    const mg = placemark.MultiGeometry;
    const points = Array.isArray(mg.Point) ? mg.Point : mg.Point ? [mg.Point] : [];
    points.forEach((p: any) => pushGeom(p, "Point"));

    const lines = Array.isArray(mg.LineString) ? mg.LineString : mg.LineString ? [mg.LineString] : [];
    lines.forEach((l: any) => pushGeom(l, "LineString"));

    const polys = Array.isArray(mg.Polygon) ? mg.Polygon : mg.Polygon ? [mg.Polygon] : [];
    polys.forEach((poly: any) => {
      const boundary = poly.outerBoundaryIs || poly.innerBoundaryIs;
      if (boundary && boundary.LinearRing) {
        pushGeom(boundary.LinearRing, "Polygon");
      } else {
        pushGeom(poly, "Polygon");
      }
    });
  }

  return geoms;
};

const extractDxfPlacemarks = (
  rootNode: any,
  parentFolderName: string = ""
): { placemark: any; folderName: string; isHomepass: boolean; category: PlacemarkCategory }[] => {
  const results: { placemark: any; folderName: string; isHomepass: boolean; category: PlacemarkCategory }[] = [];
  if (!rootNode) return results;

  const traverse = (node: any, currentFolder: string) => {
    if (!node || typeof node !== "object") return;
    const folderName = node.name ? getPlacemarkName(node) : currentFolder;

    if (node.Placemark) {
      const placemarks = Array.isArray(node.Placemark) ? node.Placemark : [node.Placemark];
      placemarks.forEach((p: any) => {
        results.push({ placemark: p, folderName, isHomepass: false, category: "default" });
      });
    }

    if (node.Folder) {
      const folders = Array.isArray(node.Folder) ? node.Folder : [node.Folder];
      folders.forEach((f: any) => traverse(f, folderName));
    }

    if (node.Document) {
      const docs = Array.isArray(node.Document) ? node.Document : [node.Document];
      docs.forEach((d: any) => traverse(d, folderName));
    }
  };

  traverse(rootNode, parentFolderName);
  return results;
};

interface TitleBlockOptions {
  d: any;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  proyek?: string;
  noKontrak?: string;
  noSp?: string;
  lokasi?: string;
  namaGambar?: string;
  lembar?: string;
}

function drawTitleBlock(opts: TitleBlockOptions) {
  const { d, minX, minY, maxX, maxY } = opts;
  d.addLayer("FRAME_OUTER", 7, "CONTINUOUS");

  const padding = 20;
  const outerX1 = minX - padding;
  const outerY1 = minY - padding;
  const outerX2 = maxX + padding;
  const outerY2 = maxY + padding;

  d.setActiveLayer("FRAME_OUTER");
  // @ts-ignore
  d.drawPolyline([[outerX1, outerY1], [outerX2, outerY1], [outerX2, outerY2], [outerX1, outerY2], [outerX1, outerY1]], true);
}

// =========================================================================
// LOGIKA KHUSUS TELKOM (MITRA C) - PETA JALUR & SIMBOL AKURAT
// =========================================================================

// --- helper teks KML (nama bisa multi-baris / berisi <br>, deskripsi bisa HTML/CDATA) ---
const kmlTextOf = (v: any): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && v["#text"] !== undefined) return String(v["#text"]);
  return "";
};

const htmlToLines = (raw: string): string[] =>
  raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

// buang karakter kontrol MTEXT agar tidak merusak format
const cleanMTextLine = (s: string): string => s.replace(/[\\{}^~]/g, " ").replace(/\s+/g, " ").trim();

const stripStatusTag = (s: string): string =>
  s.replace(/\(\s*(?:NEW|EXISTING|EKS)\s*\)/gi, "").replace(/\s+/g, " ").trim();

function drawMitraC(opts: {
  d: any;
  root: any;
  projKml: (lon: number, lat: number) => { x: number; y: number };
  collectGeometries: (placemark: any) => { kind: string; coordinates: string }[];
  getPlacemarkName: (placemark: any) => string;
}): MitraCResult {
  const { d, root, projKml, collectGeometries, getPlacemarkName } = opts;

  const L_MAIN = "TELKOM_KABEL_UTAMA";    // Biru (ACI 5)
  const L_BRANCH = "TELKOM_KABEL_CABANG"; // Kuning (ACI 2)
  const L_SYMBOL = "TELKOM_SIMBOL";       // Putih (ACI 7)
  const L_TEXT = "TELKOM_TEXT";           // Putih (ACI 7)
  const L_OTHER = "TELKOM_LAINNYA";       // Putih (ACI 7)
  d.addLayer(L_MAIN, 5, "CONTINUOUS");
  d.addLayer(L_BRANCH, 2, "CONTINUOUS");
  d.addLayer(L_SYMBOL, 7, "CONTINUOUS");
  d.addLayer(L_TEXT, 7, "CONTINUOUS");
  d.addLayer(L_OTHER, 7, "CONTINUOUS");

  // Ukuran dalam meter (peta dilihat dari jauh, jadi simbol & teks harus cukup besar)
  const TEXT_H = 6;          // tinggi teks label
  const LINE_W = 2.5;        // ketebalan jalur kabel
  const TRI_HALF_W = 13;     // setengah lebar segitiga ODP
  const TRI_H = 24;          // tinggi segitiga ODP
  const UC_R = 9;            // radius simbol UC
  const ODC_K = 0.75;        // skala simbol ODC
  const MTEXT_SPACING = TEXT_H * (5 / 3);

  type NodeKind = "ODC" | "ODP" | "UC";
  type MapNode = {
    kind: NodeKind | null;
    name: string;
    lines: string[];
    x: number;
    y: number;
    lon: number;
    lat: number;
    isEks: boolean;
    twb: string | null;
  };
  type MapRoute = { pts: [number, number][]; isEks: boolean; closed: boolean; fromNonSegment: boolean };

  const entries = extractDxfPlacemarks(root);
  const nodes: MapNode[] = [];
  const routes: MapRoute[] = [];

  const parseCoordList = (s: string): [number, number][] =>
    s
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const p = tok.split(",");
        const lon = parseFloatVal(p[0]);
        const lat = parseFloatVal(p[1]);
        return lon !== null && lat !== null ? ([lon, lat] as [number, number]) : null;
      })
      .filter((pt): pt is [number, number] => pt !== null);

  // ---------- 1. Baca semua placemark ----------
  entries.forEach(({ placemark, folderName }) => {
    const rawName = getPlacemarkName(placemark);
    const searchName = `${folderName || ""} ${rawName}`.toUpperCase();
    const upperFolder = (folderName || "").toUpperCase();
    const isNonSegment = /NON[\s-]*SEGMEN/.test(upperFolder);
    const isEks = /EKS|EXISTING/.test(searchName);

    const nameLines = htmlToLines(kmlTextOf(placemark.name));
    const descLines = htmlToLines(kmlTextOf(placemark.description));
    const twbMatch = JSON.stringify(placemark || {}).match(/Tw[bB][0-9A-Za-z]{6,}/);

    collectGeometries(placemark).forEach((g) => {
      if (g.kind === "LineString" || g.kind === "Polygon") {
        const coords = parseCoordList(g.coordinates);
        if (coords.length < 2) return;
        routes.push({
          pts: coords.map(([lon, lat]) => {
            const p = projKml(lon, lat);
            return [p.x, p.y] as [number, number];
          }),
          isEks,
          closed: g.kind === "Polygon",
          fromNonSegment: isNonSegment && g.kind === "LineString",
        });
        return;
      }

      if (g.kind !== "Point" || isNonSegment) return;
      const c = parseCoordList(g.coordinates);
      if (c.length === 0) return;
      const [lon, lat] = c[0];
      const p = projKml(lon, lat);

      let kind: NodeKind | null = null;
      if (/\bODC\b/.test(searchName)) kind = "ODC";
      else if (/\b(UC|CLOSURE|SPLICE)\b|\bAS-|\bJB\b/.test(searchName)) kind = "UC";
      else if (/\b(ODP|FAT|FDT)\b/.test(searchName)) kind = "ODP";

      nodes.push({
        kind,
        name: kind === "ODC" ? rawName : stripStatusTag(nameLines.join(" ") || rawName),
        lines: [...nameLines, ...descLines],
        x: p.x,
        y: p.y,
        lon,
        lat,
        isEks,
        twb: twbMatch ? twbMatch[0] : null,
      });
    });
  });

  // ---------- 2. Klasifikasi jalur: biru (utama) / kuning (cabang dari UC) ----------
  const nearestNodeAt = (pt: [number, number], maxDist = 40): MapNode | null => {
    let best: MapNode | null = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      if (!n.kind) continue;
      const dist = Math.hypot(n.x - pt[0], n.y - pt[1]);
      if (dist < bestDist) {
        bestDist = dist;
        best = n;
      }
    }
    return bestDist <= maxDist ? best : null;
  };

  const isBranchRoute = (r: MapRoute): boolean => {
    const first = nearestNodeAt(r.pts[0]);
    const last = nearestNodeAt(r.pts[r.pts.length - 1]);
    const term = (n: MapNode | null) => !!n && (n.kind === "ODC" || n.kind === "UC");
    const source = term(first) ? first : term(last) ? last : null;
    return !!source && source.kind === "UC";
  };

  // Jika ada folder NON-SEGMEN, hanya itu yang jadi jalur utama (folder SEGMEN = nama kabel,
  // jalurnya sama sehingga tidak digambar dobel). Jika tidak ada, gambar semua LineString.
  const hasNonSegment = routes.some((r) => r.fromNonSegment);

  // ---------- 3. Gambar jalur ----------
  let drawnRoutes = 0;
  routes.forEach((r) => {
    if (r.closed) {
      d.setActiveLayer(L_OTHER);
      // @ts-ignore
      d.drawPolyline(r.pts, true);
      return;
    }
    if (hasNonSegment && !r.fromNonSegment) return;
    d.setActiveLayer(isBranchRoute(r) ? L_BRANCH : L_MAIN);
    // @ts-ignore (startWidth, endWidth = ketebalan polyline)
    d.drawPolyline(r.pts, false, LINE_W, LINE_W);
    drawnRoutes++;
  });

  // ---------- 4. Simbol ----------
  // Segitiga solid (bold, bukan arsiran): polyline 2 titik dengan lebar awal = lebar alas
  // dan lebar akhir = 0, sehingga terisi penuh berbentuk segitiga.
  const solidTriangle = (x: number, y: number) => {
    const baseY = y - TRI_H * 0.42;
    // @ts-ignore (startWidth, endWidth)
    d.drawPolyline([[x, baseY], [x, baseY + TRI_H]], false, TRI_HALF_W * 2, 0);
  };

  const drawOdpSymbol = (n: MapNode) => {
    const baseY = n.y - TRI_H * 0.42;
    d.setActiveLayer(L_SYMBOL);
    // @ts-ignore
    d.drawPolyline(
      [[n.x, baseY + TRI_H], [n.x - TRI_HALF_W, baseY], [n.x + TRI_HALF_W, baseY], [n.x, baseY + TRI_H]],
      true
    );
    if (!n.isEks) solidTriangle(n.x, n.y); // NEW = solid, EXISTING = outline
  };

  const drawUcSymbol = (n: MapNode) => {
    d.setActiveLayer(L_SYMBOL);
    d.drawArc(n.x, n.y, UC_R, 0, 360);
    d.drawLine(n.x - UC_R - 3, n.y + UC_R + 3, n.x + UC_R + 3, n.y - UC_R - 3);
  };

  const drawOdcSymbol = (n: MapNode) => {
    const k = ODC_K;
    const x = n.x;
    const y = n.y - 12;
    const P = (dx: number, dy: number): [number, number] => [x + dx * k, y + dy * k];
    d.setActiveLayer(L_SYMBOL);
    // @ts-ignore
    d.drawPolyline([P(0, 35), P(-25, 0), P(25, 0), P(0, 35)], true);
    // @ts-ignore
    d.drawPolyline([P(0, 29), P(-19, 3), P(19, 3), P(0, 29)], true);
    const a = P(0, 3), b = P(0, 29);
    d.drawLine(a[0], a[1], b[0], b[1]);
    const c1 = P(-9.5, 16), c2 = P(19, 3);
    d.drawLine(c1[0], c1[1], c2[0], c2[1]);
    const c3 = P(9.5, 16), c4 = P(-19, 3);
    d.drawLine(c3[0], c3[1], c4[0], c4[1]);
  };

  const drawGenericPoint = (n: MapNode) => {
    d.setActiveLayer(L_SYMBOL);
    d.drawArc(n.x, n.y, 3, 0, 360);
    d.drawLine(n.x - 4.5, n.y + 4.5, n.x + 4.5, n.y - 4.5);
  };

  // ---------- 5. Label (MTEXT multi-baris, hindari tabrakan) ----------
  type Box = { x1: number; y1: number; x2: number; y2: number };
  const placed: Box[] = [];
  const hits = (b: Box) =>
    placed.some((p) => b.x1 < p.x2 + 2 && b.x2 > p.x1 - 2 && b.y1 < p.y2 + 2 && b.y2 > p.y1 - 2);

  // simbol dianggap sudah menempati ruang agar label tidak menutupinya
  nodes.forEach((n) => {
    if (!n.kind) return;
    const half = n.kind === "ODC" ? 24 : 14;
    placed.push({ x1: n.x - half, y1: n.y - half, x2: n.x + half, y2: n.y + half });
  });

  const coordLine = (n: MapNode) => `${n.lat.toFixed(6)}%%d ${n.lon.toFixed(6)}%%d`;

  const buildLabelLines = (n: MapNode): string[] => {
    const tag = n.isEks ? "(EXISTING)" : "(NEW)";
    const rawLines = n.lines.map(cleanMTextLine).filter(Boolean);
    const cleanedLines = rawLines
      .map((l) => stripStatusTag(l))
      .filter((l) => l && !/^(NEW|EXISTING|EKS)$/i.test(l));

    if (n.kind === "ODC") {
      return [...(rawLines.length ? rawLines : [cleanMTextLine(n.name)]), coordLine(n)];
    }

    if (n.kind === "UC") {
      return ["NEW", ...(cleanedLines.length ? cleanedLines : [cleanMTextLine(n.name)]), coordLine(n)]
        .map((l, i) => (i === 0 && n.isEks ? "EXISTING" : l));
    }

    // ODP: kalau KML sudah punya baris keterangan lengkap, pakai apa adanya
    if (cleanedLines.length >= 4) {
      const out = [tag, ...cleanedLines];
      if (n.twb && !out.some((l) => l.includes(n.twb!))) out.push(n.twb);
      out.push(coordLine(n));
      return out;
    }

    // Kalau tidak, turunkan dari nama: "ODP-CRM-FAA/94 D.08 10"
    const base = cleanMTextLine(n.name);
    const m = base.match(/^(.*?FAA\/(\d+))\s+D\.(\d+)\s*(.*)$/i);
    if (!m) {
      const out = [tag, base];
      if (n.twb) out.push(n.twb);
      out.push(coordLine(n));
      return out;
    }
    const [, odpBase, num, dNo, coreRaw] = m;
    const cores = coreRaw.split(/[^0-9]+/).filter(Boolean).map((c) => c.padStart(2, "0"));
    const qty = Math.max(cores.length, 1);
    const out = [
      tag,
      base,
      odpBase,
      `FAA/D${dNo.padStart(2, "0")}/${num}.01`,
      `ODP-SOLID-PB-8-AS x${qty}`,
      `PS-1:8-ODP x${qty}`,
      `OS-SM-1 x${qty}`,
      `CORE [${cores.length ? cores.join(",") : "-"}]`,
    ];
    if (n.twb) out.push(n.twb);
    out.push(coordLine(n));
    return out;
  };

  const placeLabel = (n: MapNode, lines: string[]) => {
    const w = Math.max(...lines.map((l) => l.replace(/%%d/g, "o").length), 1) * TEXT_H * 0.6;
    const h = lines.length * MTEXT_SPACING;
    const base = n.kind === "ODC" ? 30 : n.kind === "UC" ? 16 : 20;

    type Cand = { ax: number; ay: number; attach: number; box: Box };
    const candidates = (gap: number): Cand[] => [
      { ax: n.x, ay: n.y + gap, attach: 8, box: { x1: n.x - w / 2, y1: n.y + gap, x2: n.x + w / 2, y2: n.y + gap + h } },
      { ax: n.x + gap, ay: n.y, attach: 4, box: { x1: n.x + gap, y1: n.y - h / 2, x2: n.x + gap + w, y2: n.y + h / 2 } },
      { ax: n.x, ay: n.y - gap, attach: 2, box: { x1: n.x - w / 2, y1: n.y - gap - h, x2: n.x + w / 2, y2: n.y - gap } },
      { ax: n.x - gap, ay: n.y, attach: 6, box: { x1: n.x - gap - w, y1: n.y - h / 2, x2: n.x - gap, y2: n.y + h / 2 } },
    ];

    let chosen: Cand | null = null;
    for (let k = 0; k <= 8 && !chosen; k++) {
      for (const c of candidates(base + k * 14)) {
        if (!hits(c.box)) {
          chosen = c;
          break;
        }
      }
    }
    if (!chosen) chosen = candidates(base)[0];
    placed.push(chosen.box);

    // Teks biasa (TEXT) per baris, sama seperti label lain yang sudah terbukti tampil.
    d.setActiveLayer(L_TEXT);
    const top = chosen.box.y2;
    lines.forEach((line, i) => {
      const lw = line.replace(/%%d/g, "o").length * TEXT_H * 0.6;
      let tx = chosen!.ax;
      if (chosen!.attach === 8 || chosen!.attach === 2) tx = chosen!.ax - lw / 2; // rata tengah
      else if (chosen!.attach === 6) tx = chosen!.ax - lw;                        // rata kanan
      const ty = top - i * MTEXT_SPACING - TEXT_H * 1.2;
      d.drawText(tx, ty, TEXT_H, 0, line);
    });
  };

  // ---------- 6. Gambar semua node ----------
  let drawnNodes = 0;
  nodes.forEach((n) => {
    if (n.kind === "ODC") drawOdcSymbol(n);
    else if (n.kind === "UC") drawUcSymbol(n);
    else if (n.kind === "ODP") drawOdpSymbol(n);
    else {
      drawGenericPoint(n);
      return; // titik biasa (tiang/handhole) tanpa label
    }
    drawnNodes++;
    placeLabel(n, buildLabelLines(n));
  });

  console.log(`[MitraC] placemark=${entries.length}, node berlabel=${drawnNodes}, jalur=${drawnRoutes}`);
  if (entries.length === 0) {
    console.warn("[MitraC] Tidak ada Placemark terbaca dari KML. Cek struktur Folder/Document.");
  }

  return { success: true, nodes: drawnNodes, routes: drawnRoutes };
}

// ==========================================
// 4. SETUP APP, CORS & MULTER DISK (+ PENYESUAIAN ELECTRON)
// ==========================================
const app = express();

// Port default tetap 5000 (sama dengan API_BASE di frontend: http://localhost:5000)
const DEFAULT_PORT = Number(process.env.PORT) || 5000;
// Desktop app: hanya bisa diakses dari komputer itu sendiri (bukan dari jaringan/LAN)
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";

const IS_ELECTRON = !!process.versions.electron;

app.use(
  cors({
    // Renderer Electron (file://) mengirim Origin "null" -> izinkan semua + expose nama file download
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(express.json());

// Folder upload sementara (selalu writable di Windows/macOS/Linux)
const uploadDir = process.env.KML_UPLOAD_DIR || path.join(os.tmpdir(), "kml_uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

// Folder kerja sementara untuk file Overture.
// Web/dev: tetap folder project (process.cwd()) seperti server.ts asli.
// Electron (terinstall): cwd bisa read-only (Program Files / app.asar), jadi pakai folder temp OS.
const TEMP_WORK_DIR =
  process.env.KML_TEMP_DIR || (IS_ELECTRON ? os.tmpdir() : process.cwd());

// Lokasi CLI overturemaps: tetap cek lokasi asli dulu, kalau tidak ada coba dari PATH.
const resolveOvertureCli = (): string => {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "overturemaps"),
    path.join(os.homedir(), ".local", "bin", "overturemaps.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "overturemaps";
};

// Health check (dipakai electron/main.ts untuk menunggu server siap)
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ==========================================
// 5. ENDPOINT KML TO DXF (logika sama dengan server.ts website)
// ==========================================
app.post("/api/upload_kml", upload.single("file"), async (req: any, res: any) => {
  if (!req.file) {
    console.error("❌ Error: Tidak ada file KML yang diunggah.");
    return res.status(400).json({ error: "Harap masukkan file KML/KMZ terlebih dahulu sebelum melakukan generate!" });
  }

  try {
    const kmlContent = fs.readFileSync(req.file.path, "utf-8");
    const parser = new XMLParser(KML_PARSER_OPTIONS);
    const jsonObj = parser.parse(kmlContent);

    const offsetXMeters = parseFloat(req.body?.offsetX) || 0;
    const offsetYMeters = parseFloat(req.body?.offsetY) || 0;

    let globalTextRotationDeg = 0;
    const manualLabelRotation =
      req.body?.labelRotation !== undefined && req.body.labelRotation !== ""
        ? parseFloat(req.body.labelRotation)
        : null;
    if (manualLabelRotation !== null && !isNaN(manualLabelRotation)) {
      globalTextRotationDeg = manualLabelRotation;
    }

    const houseLabelMode: "building" | "vertical" | "street" =
      req.body?.houseLabelMode === "vertical" || req.body?.houseLabelMode === "street"
        ? req.body.houseLabelMode
        : "building";

    let houseLabelRotationDeg = 90;
    const manualHouseLabelRotation =
      req.body?.houseLabelRotation !== undefined && req.body.houseLabelRotation !== ""
        ? parseFloat(req.body.houseLabelRotation)
        : null;
    if (manualHouseLabelRotation !== null && !isNaN(manualHouseLabelRotation)) {
      houseLabelRotationDeg = manualHouseLabelRotation;
    }

    const POLE_LABEL_ROTATION_DEG = 90;

    type BuildingFootprint = { cx: number; cy: number; angleDeg: number; lengthAlongAxis: number };
    const buildingFootprints: BuildingFootprint[] = [];

    const findNearestBuilding = (x: number, y: number, maxDist = 12): BuildingFootprint | null => {
      let best: BuildingFootprint | null = null;
      let bestDist = maxDist;
      for (const b of buildingFootprints) {
        const dx = b.cx - x;
        const dy = b.cy - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = b;
        }
      }
      return best;
    };

    const d = new Drawing();
    // @ts-ignore
    d.setUnits("Meters");
    // @ts-ignore
    d.addLineType("DASHEDSMALL", "_ _ _ _", [2.5, -2.5]);

    const _projRaw = (lon: number, lat: number) => {
       const r = 6378137;
       const x = (lon * Math.PI / 180) * r;
       const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * r;
       return { x, y };
    };

    const getAciColorForCable = (name: string): number => {
      const u = name.toUpperCase();
      const checkColor = (code: string) => {
         if (code === '01') return 150;
         if (code === '02') return 40;
         if (code === '03') return 80;
         if (code === '04') return 34;
         if (code === '05') return 9;
         if (code === '06') return 7;
         if (code === '07') return 1;
         if (code === '08') return 250;
         if (code === '09') return 2;
         if (code === '10') return 200;
         if (code === '11') return 210;
         if (code === '12') return 4;
         return null;
      };

      for (let i = 1; i <= 12; i++) {
         const c = i.toString().padStart(2, '0');
         if (u.includes(`D.${c}`)) {
             const mapped = checkColor(c);
             if (mapped) return mapped;
         }
      }

      const matchSuffix = u.match(/(\d{2})$/);
      if (matchSuffix) {
         const mapped = checkColor(matchSuffix[1]);
         if (mapped) return mapped;
      }

      return 3;
    };

    d.addLayer("OSM_Highway", 8, "CONTINUOUS");
    d.addLayer("OSM_Highway_Inner", 8, "CONTINUOUS");
    d.addLayer("OSM_Building", 9, "CONTINUOUS");

    for (let i = 1; i <= 12; i++) {
      const code = `D.${i.toString().padStart(2, '0')}`;
      d.addLayer(`KML_${code}`, getAciColorForCable(code), "CONTINUOUS");
    }
    d.addLayer("KML_Default", 3, "CONTINUOUS");
    d.addLayer("KML_Points", 1, "CONTINUOUS");
    d.addLayer("KML_Rumah", 6, "CONTINUOUS");

    d.addLayer("APD_HP_Cover", 6, "CONTINUOUS");
    d.addLayer("APD_HP_Uncover", 1, "CONTINUOUS");
    d.addLayer("APD_FDT", 1, "CONTINUOUS");
    d.addLayer("APD_FAT", 30, "CONTINUOUS");

    d.addLayer("APD_FAT_A", 5, "CONTINUOUS");
    d.addLayer("APD_FAT_B", 40, "CONTINUOUS");
    d.addLayer("APD_FAT_C", 3, "CONTINUOUS");
    d.addLayer("APD_FAT_YELLOW", 2, "CONTINUOUS");
    d.addLayer("APD_FAT_Boundary", 4, "DASHEDSMALL");

    d.addLayer("APD_OTB", 5, "CONTINUOUS");
    d.addLayer("APD_HH", 30, "CONTINUOUS");
    d.addLayer("APD_ONT", 7, "CONTINUOUS");
    d.addLayer("APD_Closure", 1, "CONTINUOUS");
    d.addLayer("APD_FigureEight", 1, "CONTINUOUS");

    d.addLayer("APD_Pole_New_9M", 5, "CONTINUOUS");
    d.addLayer("APD_Pole_New_7M_4", 3, "CONTINUOUS");
    d.addLayer("APD_Pole_New_7M_3", 4, "CONTINUOUS");
    d.addLayer("APD_Pole_Existing", 1, "CONTINUOUS");
    d.addLayer("APD_Pole_Removed", 1, "CONTINUOUS");

    d.addLayer("APD_GarduPLN", 30, "CONTINUOUS");
    d.addLayer("APD_STO", 6, "CONTINUOUS");
    d.addLayer("APD_SlackHanger", 1, "CONTINUOUS");
    d.addLayer("APD_SlingWire", 4, "CONTINUOUS");
    // @ts-ignore
    (d as any).layers["APD_SlingWire"].setTrueColor((0 << 16) | (168 << 8) | 156);
    d.addLayer("APD_BoundaryCluster", 3, "CONTINUOUS");
    d.addLayer("APD_Label", 7, "CONTINUOUS");

    const FIBER_CORE_COLORS: { core: number; aci: number }[] = [
      { core: 12, aci: 30 },
      { core: 24, aci: 3 },
      { core: 36, aci: 200 },
      { core: 48, aci: 200 },
      { core: 72, aci: 42 },
      { core: 96, aci: 1 },
      { core: 144, aci: 62 },
      { core: 288, aci: 30 },
    ];
    FIBER_CORE_COLORS.forEach(({ core, aci }) => {
      d.addLayer(`APD_Cable_${core}C`, aci, "CONTINUOUS");
    });
    d.addLayer("APD_Cable_Default", 7, "CONTINUOUS");

    const getFatLayer = (name: string): string => {
      const upper = name.toUpperCase();
      if (/A\d+/.test(upper) || /\bA\b/.test(upper) || /FATA/.test(upper)) return "APD_FAT_A";
      if (/B\d+/.test(upper) || /\bB\b/.test(upper) || /FATB/.test(upper)) return "APD_FAT_B";
      if (/C\d+/.test(upper) || /\bC\b/.test(upper) || /FATC/.test(upper)) return "APD_FAT_C";
      return "APD_FAT_A";
    };

    const placemarkEntries = extractDxfPlacemarks(jsonObj.kml || jsonObj);
    const placemarks = placemarkEntries.map((e) => e.placemark);

    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const updateBounds = (lon: number, lat: number) => {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    };

    // PERBAIKAN: koordinat yang gagal di-parse DILEWATI (sebelumnya jadi 0,0 sehingga
    // bounding box meledak ke titik nol bumi dan seluruh gambar tergeser jauh / tampak kosong).
    placemarks.forEach((p) => {
      const geoms = collectGeometries(p);
      geoms.forEach((g) => {
        const rawCoords = g.kind === "Point" ? [g.coordinates.trim()] : g.coordinates.trim().split(/\s+/);
        rawCoords.forEach((c: string) => {
          const parts = c.split(",");
          if (parts.length < 2) return;
          const lon = parseFloatVal(parts[0]);
          const lat = parseFloatVal(parts[1]);
          if (lon === null || lat === null) return;
          updateBounds(lon, lat);
        });
      });
    });

    const centerLon = minLon === Infinity ? 0 : (minLon + maxLon) / 2;
    const centerLat = minLat === Infinity ? 0 : (minLat + maxLat) / 2;

    const centerPrjRaw = _projRaw(centerLon, centerLat);
    const trueLocalScale = Math.cos(centerLat * Math.PI / 180);

    const proj = (lon: number, lat: number) => {
       const p = _projRaw(lon, lat);
       return {
           x: (p.x - centerPrjRaw.x) * trueLocalScale,
           y: (p.y - centerPrjRaw.y) * trueLocalScale
       };
    };

    const projKml = (lon: number, lat: number) => {
       const p = proj(lon, lat);
       return { x: p.x + offsetXMeters, y: p.y + offsetYMeters };
    };

    if (minLon !== Infinity && minLat !== Infinity) {
      const padLon = (maxLon - minLon) * 0.1 || 0.002;
      const padLat = (maxLat - minLat) * 0.1 || 0.002;
      const offsetLonDeg = Math.abs(offsetXMeters) / (111320 * Math.cos(centerLat * Math.PI / 180) || 111320);
      const offsetLatDeg = Math.abs(offsetYMeters) / 111320;
      const bMinLon = minLon - padLon - offsetLonDeg;
      const bMinLat = minLat - padLat - offsetLatDeg;
      const bMaxLon = maxLon + padLon + offsetLonDeg;
      const bMaxLat = maxLat + padLat + offsetLatDeg;

      const overpassQuery = `
        [out:json][timeout:90];
        (
          way["highway"](${bMinLat},${bMinLon},${bMaxLat},${bMaxLon});
          way["building"](${bMinLat},${bMinLon},${bMaxLat},${bMaxLon}); 
        );
        out body;
        >;
        out skel qt;
      `;

      let osmData: any = null;
      let fetchSuccess = false;
      const endpoints = [
         "https://lz4.overpass-api.de/api/interpreter",
         "https://overpass-api.de/api/interpreter",
         "https://overpass.kumi.systems/api/interpreter",
         "https://overpass.osm.ch/api/interpreter"
      ];

      console.log("-----------------------------------------------------");
      console.log(`[OSM] Memulai download peta jalan & rumah (Area: ${bMinLon.toFixed(4)}, ${bMinLat.toFixed(4)})...`);

      for (const endpoint of endpoints) {
         try {
            console.log(`[OSM] Mencoba menghubungi: ${endpoint}...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 90000);
            const osmRes = await fetch(endpoint, {
               method: "POST",
               body: overpassQuery,
               headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "User-Agent": "KMLtoDXFConverter/5.0"
               },
               signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (osmRes.ok) {
               osmData = await osmRes.json();
               fetchSuccess = true;
               console.log(`✅ [OSM] Sukses mengunduh peta dari ${endpoint}`);
               break;
            } else {
               console.warn(`⚠️ [OSM] Gagal dari ${endpoint}: HTTP ${osmRes.status}`);
            }
         } catch (e: any) {
            console.error(`❌ [OSM] Error/Timeout dari ${endpoint}: ${e.message}`);
         }
      }

      if (!fetchSuccess) {
         console.error("\n=========================================================================");
         console.error("🔴 PERINGATAN: GAGAL MENDOWNLOAD PETA OPENSTREETMAP (OSM) 🔴");
         console.error("Semua server publik saat ini sedang sibuk, membatasi request, atau down.");
         console.error("File DXF tetap akan dibuat, tapi HANYA menampilkan data KML tanpa rumah & jalan.");
         console.error("Solusi: Tunggu beberapa menit lalu coba upload lagi file KML Anda.");
         console.error("=========================================================================\n");
      } else if (osmData && osmData.elements) {
         const nodeMap = new Map<number, { lon: number, lat: number, x: number, y: number }>();
         osmData.elements.forEach((el: any) => {
            if (el.type === "node") {
               const prj = proj(el.lon, el.lat);
               nodeMap.set(el.id, { lon: el.lon, lat: el.lat, x: prj.x, y: prj.y });
            }
         });

         if (manualLabelRotation === null) {
            let maxSegLen = 0;
            let bestAngleDeg = 0;
            osmData.elements.forEach((el: any) => {
               if (el.type === "way" && el.nodes && el.tags && el.tags.highway) {
                  for (let i = 0; i < el.nodes.length - 1; i++) {
                     const a = nodeMap.get(el.nodes[i]);
                     const b = nodeMap.get(el.nodes[i + 1]);
                     if (!a || !b) continue;
                     const dx = b.x - a.x;
                     const dy = b.y - a.y;
                     const segLen = Math.sqrt(dx * dx + dy * dy);
                     if (segLen > maxSegLen) {
                        maxSegLen = segLen;
                        bestAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
                     }
                  }
               }
            });
            while (bestAngleDeg > 90) bestAngleDeg -= 180;
            while (bestAngleDeg < -90) bestAngleDeg += 180;
            globalTextRotationDeg = maxSegLen > 0 ? bestAngleDeg : 0;
         }

         const drawRoadOutline = (offsetMeters: number, layerName: string) => {
            const bufferGeoms: any[] = [];
            osmData.elements.forEach((el: any) => {
               if (el.type === "way" && el.nodes && el.tags && el.tags.highway) {
                  const coords: [number, number][] = [];
                  el.nodes.forEach((nid: number) => {
                     const n = nodeMap.get(nid);
                     if (n) coords.push([n.lon, n.lat]);
                  });

                  if (coords.length > 1) {
                     try {
                        const line = turf.lineString(coords);
                        const buffered = turf.buffer(line, offsetMeters, { units: "meters" });
                        if (buffered && buffered.geometry) {
                           const geom = buffered.geometry;
                           bufferGeoms.push(geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates);
                        }
                     } catch (e: any) {}
                  }
               }
            });

            let unified: any[] = [];
            if (bufferGeoms.length === 1) {
               unified = bufferGeoms[0];
            } else if (bufferGeoms.length > 1) {
               try {
                  unified = polygonClipping.union(bufferGeoms[0], ...bufferGeoms.slice(1));
               } catch (e: any) {
                  unified = ([] as any[]).concat(...bufferGeoms);
               }
            }

            d.setActiveLayer(layerName);
            unified.forEach((polygon: number[][][]) => {
               polygon.forEach((ring: number[][]) => {
                  const projectedRing: [number, number][] = ring.map(([lon, lat]) => {
                     const p = proj(lon, lat);
                     return [p.x, p.y];
                  });
                  if (projectedRing.length > 2) {
                     // @ts-ignore
                     d.drawPolyline(projectedRing, true);
                  }
               });
            });
         };

         const lebarJalanTotal = 6;
         const ROAD_WIDTH_DIFFERENCE = 1;
         const jarakOffsetLuar = lebarJalanTotal / 2;
         const jarakOffsetDalam = jarakOffsetLuar - ROAD_WIDTH_DIFFERENCE / 2;

         drawRoadOutline(jarakOffsetLuar, "OSM_Highway");
         if (jarakOffsetDalam > 0) {
            drawRoadOutline(jarakOffsetDalam, "OSM_Highway_Inner");
         }

         // =========================================================================
         // EKSTRAKSI BANGUNAN (HANYA JIKA MODE 'ROUTE_HOMEPASS' DIPILIH)
         // =========================================================================
         if (req.body?.mode === 'route_homepass') {
             console.log(`[Overture] Mengunduh poligon rumah presisi AI (via File Project)...`);
             let overtureSuccess = false;

             try {
               const overturePath = resolveOvertureCli();
               const tempOvertureFile = path.join(TEMP_WORK_DIR, `overture_dxf_${Date.now()}.geojson`);

               const cmd = `"${overturePath}" download --bbox ${bMinLon},${bMinLat},${bMaxLon},${bMaxLat} -f geojson --type building -o "${tempOvertureFile}"`;

               await new Promise<void>((resolve) => {
                 exec(cmd, { timeout: 120000, maxBuffer: 1024 * 1024 * 50, env: process.env }, (error, stdout, stderr) => {
                   if (error) console.error(`[Overture] CLI Error:`, error.message);
                   if (stdout && stdout.trim()) console.log(`[Overture] CLI Stdout:`, stdout.trim().substring(0, 200));

                   try {
                     if (fs.existsSync(tempOvertureFile)) {
                         const rawData = fs.readFileSync(tempOvertureFile, 'utf-8');
                         const geojsonData = JSON.parse(rawData);
                         const features = geojsonData.features || [];

                         if (features.length > 0) {
                             overtureSuccess = true;
                             console.log(`✅ [Overture] Sukses membaca ${features.length} bangunan dari file.`);

                             features.forEach((f: any) => {
                               const geo = f.geometry;
                               if (!geo) return;

                               let rings: number[][][] = [];
                               if (geo.type === "Polygon") {
                                 rings = [geo.coordinates[0]];
                               } else if (geo.type === "MultiPolygon") {
                                 rings = geo.coordinates.map((poly: any) => poly[0]);
                               }

                               rings.forEach((ring: number[][]) => {
                                 const pts: [number, number][] = ring.map((coord: number[]) => {
                                   const p = proj(coord[0], coord[1]);
                                   return [p.x, p.y];
                                 });

                                 if (pts.length > 2) {
                                   d.setActiveLayer("OSM_Building");
                                   // @ts-ignore
                                   d.drawPolyline(pts, true);

                                   let sumX = 0, sumY = 0;
                                   let maxSideLen = 0, bestSideAngle = 0;

                                   for (let i = 0; i < pts.length; i++) {
                                     sumX += pts[i][0];
                                     sumY += pts[i][1];
                                     const next = pts[(i + 1) % pts.length];
                                     const dx = next[0] - pts[i][0];
                                     const dy = next[1] - pts[i][1];
                                     const len = Math.sqrt(dx * dx + dy * dy);
                                     if (len > maxSideLen) {
                                       maxSideLen = len;
                                       bestSideAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
                                     }
                                   }

                                   while (bestSideAngle > 90) bestSideAngle -= 180;
                                   while (bestSideAngle < -90) bestSideAngle += 180;

                                   buildingFootprints.push({
                                     cx: sumX / pts.length,
                                     cy: sumY / pts.length,
                                     angleDeg: bestSideAngle,
                                     lengthAlongAxis: maxSideLen,
                                   });
                                 }
                               });
                             });
                         } else {
                              console.log(`⚠️ [Overture] File terbuat tapi kosong (tidak ada bangunan di area ini).`);
                          }
                          if (fs.existsSync(tempOvertureFile)) fs.unlinkSync(tempOvertureFile);
                          if (fs.existsSync(tempOvertureFile + '.state')) fs.unlinkSync(tempOvertureFile + '.state');
                      } else {
                         console.log(`❌ [Overture] Gagal! File tidak ditemukan di: ${tempOvertureFile}`);
                     }
                   } catch (parseError: any) {
                     console.error(`❌ [Overture] Error parsing file JSON: ${parseError.message}`);
                   }
                   resolve();
                 });
               });
             } catch (err: any) {
               console.error(`❌ [Overture] Terjadi kesalahan eksekusi: ${err.message}`);
             }

             // === FALLBACK: JIKA OVERTURE GAGAL/KOSONG, PAKAI DATA OSM ===
             if (!overtureSuccess && osmData && osmData.elements) {
                 console.log(`⚠️ [Fallback] Overture kosong/gagal, mengekstrak bangunan dari OpenStreetMap...`);
                 osmData.elements.forEach((el: any) => {
                    if (el.type === "way" && el.nodes && el.tags && el.tags.building) {
                       const buildingPts: [number, number][] = [];
                       el.nodes.forEach((nid: number) => {
                          const n = nodeMap.get(nid);
                          if (n) buildingPts.push([n.x, n.y]);
                       });
                       if (buildingPts.length > 2) {
                          d.setActiveLayer("OSM_Building");
                          // @ts-ignore
                          d.drawPolyline(buildingPts, true);

                          let sumX = 0, sumY = 0;
                          let maxSideLen = 0, bestSideAngle = 0;
                          for (let i = 0; i < buildingPts.length; i++) {
                             sumX += buildingPts[i][0];
                             sumY += buildingPts[i][1];
                             const next = buildingPts[(i + 1) % buildingPts.length];
                             const dx = next[0] - buildingPts[i][0];
                             const dy = next[1] - buildingPts[i][1];
                             const len = Math.sqrt(dx * dx + dy * dy);
                             if (len > maxSideLen) {
                               maxSideLen = len;
                               bestSideAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
                             }
                          }
                          while (bestSideAngle > 90) bestSideAngle -= 180;
                          while (bestSideAngle < -90) bestSideAngle += 180;

                          buildingFootprints.push({
                             cx: sumX / buildingPts.length,
                             cy: sumY / buildingPts.length,
                             angleDeg: bestSideAngle,
                             lengthAlongAxis: maxSideLen,
                          });
                       }
                    }
                 });
             }
         } else {
             console.log(`[Mode] Route Only: Melewati proses download & render bangunan.`);
         }
         // =========================================================================
      } // <--- PENUTUP ELSE IF OSM
    } // <--- PENUTUP IF MINLON

    const greenBoundaryPolygons: [number, number][][] = [];
    placemarkEntries.forEach(({ placemark: p, category }) => {
      if (category !== "boundary_cluster") return;
      const geoms = collectGeometries(p);
      geoms.forEach((g) => {
        if (g.kind !== "Polygon") return;
        const rawCoords = g.coordinates.trim().split(/\s+/);
        const ring: [number, number][] = rawCoords
          .map((c: string) => {
            const parts = c.split(",");
            if (parts.length < 2) return null;
            const prj = projKml(parseFloatVal(parts[0]) || 0, parseFloatVal(parts[1]) || 0);
            return [prj.x, prj.y] as [number, number];
          })
          .filter((pt): pt is [number, number] => pt !== null);
        if (ring.length >= 3) greenBoundaryPolygons.push(ring);
      });
    });

    const CHAR_WIDTH_FACTOR = 0.6;
    const DEFAULT_HOUSE_TEXT_HEIGHT = 1.6;
    const MIN_HOUSE_TEXT_HEIGHT = 0.5;
    const BUILDING_TEXT_PADDING = 1;

    const estimateTextWidth = (text: string, height: number): number =>
      Math.max(text.length, 1) * height * CHAR_WIDTH_FACTOR;

    const drawBoldText = (
      d: any,
      x: number,
      y: number,
      height: number,
      rotationDeg: number,
      text: string
    ) => {
      d.drawText(x, y, height, rotationDeg, text);
    };

    type LabelCircle = { cx: number; cy: number; r: number };
    const placedLabelCircles: LabelCircle[] = [];
    const LABEL_COLLISION_MARGIN = 0.92;

    const labelOverlapsExisting = (cx: number, cy: number, r: number): boolean =>
      placedLabelCircles.some((b) => {
        const dx = b.cx - cx;
        const dy = b.cy - cy;
        return Math.sqrt(dx * dx + dy * dy) < (b.r + r) * LABEL_COLLISION_MARGIN;
      });

    type IconCircle = { cx: number; cy: number; r: number };
    const placedIconCircles: IconCircle[] = [];
    const ICON_COLLISION_MARGIN = 0.98;

    const iconOverlapsExisting = (cx: number, cy: number, r: number): boolean =>
      placedIconCircles.some((b) => {
        const dx = b.cx - cx;
        const dy = b.cy - cy;
        return Math.sqrt(dx * dx + dy * dy) < (b.r + r) * ICON_COLLISION_MARGIN;
      });

    const findClearIconPosition = (x: number, y: number, r: number): { x: number; y: number } => {
      if (!iconOverlapsExisting(x, y, r)) {
        placedIconCircles.push({ cx: x, cy: y, r });
        return { x, y };
      }

      const baseCandidates: { dx: number; dy: number }[] = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0.7, dy: 0.7 },
        { dx: -0.7, dy: 0.7 },
        { dx: 0.7, dy: -0.7 },
        { dx: -0.7, dy: -0.7 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
      ];

      const RING_MULTIPLIERS = [2.1, 3.2, 4.3, 5.4, 6.5];
      for (const mult of RING_MULTIPLIERS) {
        for (const c of baseCandidates) {
          const dist = r * mult;
          const candX = x + c.dx * dist;
          const candY = y + c.dy * dist;
          if (!iconOverlapsExisting(candX, candY, r)) {
            placedIconCircles.push({ cx: candX, cy: candY, r });
            return { x: candX, y: candY };
          }
        }
      }

      placedIconCircles.push({ cx: x, cy: y, r });
      return { x, y };
    };

    const findClearLabelOffset = (
      x: number,
      y: number,
      text: string,
      height: number,
      defaultOffsetX: number,
      defaultOffsetY: number,
      rotationDeg: number
    ): { offsetX: number; offsetY: number } => {
      const width = estimateTextWidth(text, height);
      const radius = Math.max(width, height) * 0.6 + 0.3;
      const baseDist = Math.max(Math.abs(defaultOffsetX), Math.abs(defaultOffsetY), height * 2, width * 0.6);

      const baseCandidates: { offsetX: number; offsetY: number }[] = [
        { offsetX: defaultOffsetX, offsetY: defaultOffsetY },
        { offsetX: -(baseDist + width), offsetY: defaultOffsetY },
        { offsetX: -width / 2, offsetY: baseDist },
        { offsetX: -width / 2, offsetY: -(baseDist + height) },
        { offsetX: baseDist * 0.7, offsetY: baseDist * 0.7 },
        { offsetX: -(baseDist * 0.7 + width), offsetY: baseDist * 0.7 },
        { offsetX: baseDist * 0.7, offsetY: -(baseDist * 0.7 + height) },
        { offsetX: -(baseDist * 0.7 + width), offsetY: -(baseDist * 0.7 + height) },
      ];

      for (const cand of baseCandidates) {
        const rot = rotateOffset(cand.offsetX, cand.offsetY, rotationDeg);
        if (!labelOverlapsExisting(x + rot.x, y + rot.y, radius)) {
          return cand;
        }
      }

      const RING_DISTANCE_MULTIPLIERS = [1.3, 1.6, 2.0, 2.5];
      for (const mult of RING_DISTANCE_MULTIPLIERS) {
        for (const cand of baseCandidates) {
          const scaled = { offsetX: cand.offsetX * mult, offsetY: cand.offsetY * mult };
          const rot = rotateOffset(scaled.offsetX, scaled.offsetY, rotationDeg);
          if (!labelOverlapsExisting(x + rot.x, y + rot.y, radius)) {
            return scaled;
          }
        }
      }

      return { offsetX: defaultOffsetX, offsetY: defaultOffsetY };
    };

    const drawLabelText = (
      d: any,
      x: number,
      y: number,
      height: number,
      text: string,
      offsetX: number = 0,
      offsetY: number = 0,
      rotationDeg: number = globalTextRotationDeg
    ) => {
      const width = estimateTextWidth(text, height);
      const radius = Math.max(width, height) * 0.6 + 0.3;

      const baseOff = rotateOffset(offsetX, offsetY, rotationDeg);
      const baseX = x + baseOff.x;
      const baseY = y + baseOff.y;

      let labelX = baseX;
      let labelY = baseY;

      if (labelOverlapsExisting(labelX, labelY, radius)) {
        const maxAttempts = 12;
        const stepDistance = Math.max(radius * 0.9, 0.6);
        let found = false;
        for (let i = 1; i <= maxAttempts && !found; i++) {
          const angle = (i * 47) % 360;
          const dist = stepDistance * (1 + Math.floor((i - 1) / 6) * 0.6);
          const candX = baseX + dist * Math.cos(toRad(angle));
          const candY = baseY + dist * Math.sin(toRad(angle));
          if (!labelOverlapsExisting(candX, candY, radius)) {
            labelX = candX;
            labelY = candY;
            found = true;
          }
        }
      }

      placedLabelCircles.push({ cx: labelX, cy: labelY, r: radius });
      d.drawText(labelX, labelY, height, rotationDeg, text);
    };

    const drawSmartLabel = (
      d: any,
      x: number,
      y: number,
      height: number,
      text: string,
      defaultOffsetX: number = 0,
      defaultOffsetY: number = 0,
      rotationDeg: number = globalTextRotationDeg
    ) => {
      const { offsetX, offsetY } = findClearLabelOffset(x, y, text, height, defaultOffsetX, defaultOffsetY, rotationDeg);
      drawLabelText(d, x, y, height, text, offsetX, offsetY, rotationDeg);
    };

    const LINE_SPACING_FACTOR = 1.3;

    const estimateLinesWidth = (lines: string[], height: number): number =>
      Math.max(...lines.map((l) => estimateTextWidth(l, height)));

    const estimateLinesHeight = (lines: string[], height: number): number =>
      lines.length * height * LINE_SPACING_FACTOR;

    const findClearMultilineOffset = (
      x: number,
      y: number,
      lines: string[],
      height: number,
      defaultOffsetX: number,
      defaultOffsetY: number,
      rotationDeg: number
    ): { offsetX: number; offsetY: number } => {
      const width = estimateLinesWidth(lines, height);
      const blockHeight = estimateLinesHeight(lines, height);
      const radius = Math.max(width, blockHeight) * 0.6 + 0.3;
      const baseDist = Math.max(Math.abs(defaultOffsetX), Math.abs(defaultOffsetY), height * 2, width * 0.6);

      const baseCandidates: { offsetX: number; offsetY: number }[] = [
        { offsetX: defaultOffsetX, offsetY: defaultOffsetY },
        { offsetX: -(baseDist + width), offsetY: defaultOffsetY },
        { offsetX: -width / 2, offsetY: baseDist },
        { offsetX: -width / 2, offsetY: -(baseDist + blockHeight) },
        { offsetX: baseDist * 0.7, offsetY: baseDist * 0.7 },
        { offsetX: -(baseDist * 0.7 + width), offsetY: baseDist * 0.7 },
        { offsetX: baseDist * 0.7, offsetY: -(baseDist * 0.7 + blockHeight) },
        { offsetX: -(baseDist * 0.7 + width), offsetY: -(baseDist * 0.7 + blockHeight) },
      ];

      for (const cand of baseCandidates) {
        const rot = rotateOffset(cand.offsetX, cand.offsetY, rotationDeg);
        if (!labelOverlapsExisting(x + rot.x, y + rot.y, radius)) {
          return cand;
        }
      }

      const RING_DISTANCE_MULTIPLIERS = [1.3, 1.6, 2.0, 2.5];
      for (const mult of RING_DISTANCE_MULTIPLIERS) {
        for (const cand of baseCandidates) {
          const scaled = { offsetX: cand.offsetX * mult, offsetY: cand.offsetY * mult };
          const rot = rotateOffset(scaled.offsetX, scaled.offsetY, rotationDeg);
          if (!labelOverlapsExisting(x + rot.x, y + rot.y, radius)) {
            return scaled;
          }
        }
      }

      return { offsetX: defaultOffsetX, offsetY: defaultOffsetY };
    };

    const drawMultilineLabelText = (
      d: any,
      x: number,
      y: number,
      height: number,
      lines: string[],
      offsetX: number = 0,
      offsetY: number = 0,
      rotationDeg: number = globalTextRotationDeg
    ) => {
      const width = estimateLinesWidth(lines, height);
      const blockHeight = estimateLinesHeight(lines, height);
      const radius = Math.max(width, blockHeight) * 0.6 + 0.3;

      const baseOff = rotateOffset(offsetX, offsetY, rotationDeg);
      const baseX = x + baseOff.x;
      const baseY = y + baseOff.y;

      let anchorX = baseX;
      let anchorY = baseY;

      if (labelOverlapsExisting(anchorX, anchorY, radius)) {
        const maxAttempts = 12;
        const stepDistance = Math.max(radius * 0.9, 0.6);
        let found = false;
        for (let i = 1; i <= maxAttempts && !found; i++) {
          const angle = (i * 47) % 360;
          const dist = stepDistance * (1 + Math.floor((i - 1) / 6) * 0.6);
          const candX = baseX + dist * Math.cos(toRad(angle));
          const candY = baseY + dist * Math.sin(toRad(angle));
          if (!labelOverlapsExisting(candX, candY, radius)) {
            anchorX = candX;
            anchorY = candY;
            found = true;
          }
        }
      }

      placedLabelCircles.push({ cx: anchorX, cy: anchorY, r: radius });

      const dxAbs = anchorX - x;
      const dyAbs = anchorY - y;
      const inv = rotateOffset(dxAbs, dyAbs, -rotationDeg);

      lines.forEach((line, i) => {
        const lineLocalOffsetY = inv.y - i * height * LINE_SPACING_FACTOR;
        const r = rotateOffset(inv.x, lineLocalOffsetY, rotationDeg);
        d.drawText(x + r.x, y + r.y, height, rotationDeg, line);
      });
    };

    const drawSmartMultilineLabel = (
      d: any,
      x: number,
      y: number,
      height: number,
      lines: string[],
      defaultOffsetX: number = 0,
      defaultOffsetY: number = 0,
      rotationDeg: number = globalTextRotationDeg
    ) => {
      if (lines.length <= 1) {
        drawSmartLabel(d, x, y, height, lines[0] ?? "", defaultOffsetX, defaultOffsetY, rotationDeg);
        return;
      }
      const { offsetX, offsetY } = findClearMultilineOffset(
        x, y, lines, height, defaultOffsetX, defaultOffsetY, rotationDeg
      );
      drawMultilineLabelText(d, x, y, height, lines, offsetX, offsetY, rotationDeg);
    };

    const POLE_LABEL_WRAP_THRESHOLD = 8;
    const splitPoleNameLines = (safeName: string): string[] => {
      const dashIndex = safeName.indexOf("-");
      if (dashIndex > 0 && dashIndex < safeName.length - 1) {
        return [safeName.slice(0, dashIndex), safeName.slice(dashIndex)];
      }

      if (safeName.length <= POLE_LABEL_WRAP_THRESHOLD) {
        return [safeName];
      }

      const mid = safeName.length / 2;
      let bestDotIndex = -1;
      let bestDotDist = Infinity;
      for (let i = 0; i < safeName.length; i++) {
        if (safeName[i] === ".") {
          const dist = Math.abs(i - mid);
          if (dist < bestDotDist) {
            bestDotDist = dist;
            bestDotIndex = i;
          }
        }
      }
      if (bestDotIndex > 0 && bestDotIndex < safeName.length - 1) {
        return [safeName.slice(0, bestDotIndex), safeName.slice(bestDotIndex)];
      }

      const splitAt = Math.ceil(safeName.length / 2);
      return [safeName.slice(0, splitAt), safeName.slice(splitAt)];
    };

    const splitNameIntoWordLines = (safeName: string, maxWordsPerLine: number = 2): string[] => {
      const words = safeName.split(/\s+/).filter(Boolean);
      if (words.length <= maxWordsPerLine) return [safeName];
      const lines: string[] = [];
      for (let i = 0; i < words.length; i += maxWordsPerLine) {
        lines.push(words.slice(i, i + maxWordsPerLine).join(" "));
      }
      return lines;
    };

    const drawRectangle = (
      d: any,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      thickness: number = 0
    ) => {
        d.drawLine(x1, y1, x2, y1);
        d.drawLine(x2, y1, x2, y2);
        d.drawLine(x2, y2, x1, y2);
        d.drawLine(x1, y2, x1, y1);
        if (thickness > 0) {
          const t = thickness;
          d.drawLine(x1 + t, y1 + t, x2 - t, y1 + t);
          d.drawLine(x2 - t, y1 + t, x2 - t, y2 - t);
          d.drawLine(x2 - t, y2 - t, x1 + t, y2 - t);
          d.drawLine(x1 + t, y2 - t, x1 + t, y1 + t);
        }
    };

    const isHouseNumberName = (safeName: string, lowerName: string): boolean => {
      const s = safeName.trim();
      if (/^\d+[a-z]{0,3}$/i.test(s)) return true;
      if (/^\d+[a-z]?[\s-].+/i.test(s)) return true;
      if (/^[a-z]-\d+$/i.test(s)) return true;
      if (/^nn(-\d+)?$/i.test(s)) return true;
      if (lowerName.includes("rumah")) return true;
      return false;
    };

    const drawHouseLabel = (
      d: any,
      x: number,
      y: number,
      safeName: string,
      rotationDeg: number,
      textHeight: number,
      layerName: string = "KML_Rumah"
    ) => {
      d.setActiveLayer(layerName);
      const nameLines = splitNameIntoWordLines(safeName, 2);
      const offsetX = -estimateLinesWidth(nameLines, textHeight) / 2;
      const offsetY = -textHeight / 2;
      const radius = Math.max(estimateLinesWidth(nameLines, textHeight), estimateLinesHeight(nameLines, textHeight)) * 0.6 + 0.3;
      const anchor = rotateOffset(offsetX, offsetY, rotationDeg);
      placedLabelCircles.push({ cx: x + anchor.x, cy: y + anchor.y, r: radius });
      nameLines.forEach((line, i) => {
        const lineOffsetY = offsetY - i * textHeight * LINE_SPACING_FACTOR;
        const r = rotateOffset(offsetX, lineOffsetY, rotationDeg);
        d.drawText(x + r.x, y + r.y, textHeight, rotationDeg, line);
      });
    };

    const drawHouseMarker = (
      d: any,
      x: number,
      y: number,
      rawName: string,
      homepassCategory: PlacemarkCategory = "homepass"
    ) => {
      const safeName = sanitizeDxfText(rawName) || "Unnamed";
      const nearbyBuilding = findNearestBuilding(x, y);
      const hasOsmBuildingNearby = nearbyBuilding !== null;

      const textLayer =
        homepassCategory === "homepass_uncover"
          ? "APD_HP_Uncover"
          : homepassCategory === "homepass_cover"
          ? "APD_HP_Cover"
          : "KML_Rumah";

      let rotationDeg = houseLabelRotationDeg;
      if (manualHouseLabelRotation === null) {
        if (houseLabelMode === "building" && hasOsmBuildingNearby) {
          rotationDeg = nearbyBuilding!.angleDeg;
        } else if (houseLabelMode === "street") {
          rotationDeg = globalTextRotationDeg;
        }
      }

      let textHeight = DEFAULT_HOUSE_TEXT_HEIGHT;

      if (hasOsmBuildingNearby) {
        const availableWidth = Math.max(nearbyBuilding!.lengthAlongAxis - BUILDING_TEXT_PADDING, 0.1);
        const widthAtDefaultHeight = estimateTextWidth(safeName, DEFAULT_HOUSE_TEXT_HEIGHT);
        if (widthAtDefaultHeight > availableWidth) {
          const scale = availableWidth / widthAtDefaultHeight;
          textHeight = Math.max(DEFAULT_HOUSE_TEXT_HEIGHT * scale, MIN_HOUSE_TEXT_HEIGHT);
        }
      }

      drawHouseLabel(d, x, y, safeName, rotationDeg, textHeight, textLayer);
    };

    const getIconRadiusForName = (name: string): number => {
      if (name.includes("odc") || name.includes("fat")) return 8.4;
      if (name.includes("olt")) return 8.64;
      if (name.includes("odp") || name.includes("fdt")) return 3.33;
      if (name.includes("otb")) return 2.8;
      if (name.includes("uc")) return 1;
      if (name.includes("slack")) return 2.0;
      if (name.includes("te") || name.includes("ex")) return 1.6;
      if (name.includes("np9")) return 1.6;
      if (name.includes("np7") || name.includes("np")) return 2.26;
      if (name.includes("sto")) return 2.6;
      return 1.5;
    };

    const getNewPoleLayer = (name: string): string => {
      const upper = name.toUpperCase();
      if (/\bNP\s*-?\s*9\b/.test(upper) || upper.includes("NP9") || /\b9\s*M\b/.test(upper)) {
        return "APD_Pole_New_9M";
      }
      if (upper.includes("3\"") || upper.includes("3IN") || upper.includes("3 IN") || upper.includes("3'")) {
        return "APD_Pole_New_7M_3";
      }
      return "APD_Pole_New_7M_4";
    };

    const clampVal = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

    const getBoxWorldCorners = (
      x: number,
      y: number,
      offsetX: number,
      offsetY: number,
      boxW: number,
      boxH: number,
      rotationDeg: number
    ): [number, number][] => {
      const localCorners: [number, number][] = [
        [offsetX, offsetY],
        [offsetX + boxW, offsetY],
        [offsetX + boxW, offsetY - boxH],
        [offsetX, offsetY - boxH],
      ];
      return localCorners.map(([lx, ly]) => {
        const r = rotateOffset(lx, ly, rotationDeg);
        return [x + r.x, y + r.y] as [number, number];
      });
    };

    const boxIntersectsAnyPolygon = (
      corners: [number, number][],
      polygons: [number, number][][]
    ): boolean => {
      if (polygons.length === 0) return false;
      try {
        const ring = [...corners, corners[0]];
        const boxPoly = turf.polygon([ring]);
        for (const poly of polygons) {
          try {
            const closedRing =
              poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]
                ? poly
                : [...poly, poly[0]];
            if (closedRing.length < 4) continue;
            const otherPoly = turf.polygon([closedRing]);
            if (turf.booleanIntersects(boxPoly, otherPoly)) return true;
          } catch (e) {}
        }
      } catch (e) {
        return false;
      }
      return false;
    };

    const projectPointOutsidePolygons = (
      x: number,
      y: number,
      polygons: [number, number][][],
      margin: number = 2
    ): { x: number; y: number } | null => {
      let best: { x: number; y: number; dist: number } | null = null;
      const pt = turf.point([x, y]);
      for (const poly of polygons) {
        try {
          const closedRing =
            poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]
              ? poly
              : [...poly, poly[0]];
          if (closedRing.length < 4) continue;
          const turfPoly = turf.polygon([closedRing]);
          if (!turf.booleanPointInPolygon(pt, turfPoly)) continue;
          const line = turf.polygonToLine(turfPoly as any);
          const nearest: any = turf.nearestPointOnLine(line as any, pt);
          const nx = nearest.geometry.coordinates[0];
          const ny = nearest.geometry.coordinates[1];
          const dist = Math.sqrt((nx - x) ** 2 + (ny - y) ** 2);
          if (!best || dist < best.dist) {
            best = { x: nx, y: ny, dist };
          }
        } catch (e) {}
      }
      if (!best) return null;
      const dx = best.x - x;
      const dy = best.y - y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const pushDist = best.dist + margin;
      return { x: x + (dx / len) * pushDist, y: y + (dy / len) * pushDist };
    };

    const findNearestClearBoxOffset = (
      x: number,
      y: number,
      boxW: number,
      boxH: number,
      rotationDeg: number,
      preferredAngleDeg: number | null,
      avoidPolygons: [number, number][][] = []
    ): { offsetX: number; offsetY: number } => {
      const halfDiag = Math.sqrt(boxW * boxW + boxH * boxH) / 2;
      const radius = halfDiag + 0.5;
      const minGap = 1.2;
      const startDist = halfDiag + minGap;
      const maxDist = startDist + 80;
      const distStep = 0.75;
      const angleStep = 15;

      const isClear = (offsetX: number, offsetY: number): boolean => {
        const centerLocalX = offsetX + boxW / 2;
        const centerLocalY = offsetY - boxH / 2;
        const rot = rotateOffset(centerLocalX, centerLocalY, rotationDeg);
        if (labelOverlapsExisting(x + rot.x, y + rot.y, radius)) return false;
        if (avoidPolygons.length > 0) {
          const corners = getBoxWorldCorners(x, y, offsetX, offsetY, boxW, boxH, rotationDeg);
          if (boxIntersectsAnyPolygon(corners, avoidPolygons)) return false;
        }
        return true;
      };

      const baseAngles: number[] = [];
      for (let a = 0; a < 360; a += angleStep) baseAngles.push(a);

      let angles = baseAngles;
      if (preferredAngleDeg !== null) {
        angles = [...baseAngles].sort((a, b) => {
          const diff = (v: number) => {
            const raw = Math.abs(v - preferredAngleDeg);
            return Math.min(raw, 360 - raw);
          };
          return diff(a) - diff(b);
        });
      }

      for (let dist = startDist; dist <= maxDist; dist += distStep) {
        for (const angle of angles) {
          const rad = toRad(angle);
          const centerWorldDx = dist * Math.cos(rad);
          const centerWorldDy = dist * Math.sin(rad);
          const localCenter = rotateOffset(centerWorldDx, centerWorldDy, -rotationDeg);
          const offsetX = localCenter.x - boxW / 2;
          const offsetY = localCenter.y + boxH / 2;
          if (isClear(offsetX, offsetY)) {
            return { offsetX, offsetY };
          }
        }
      }

      const fallbackAngle = preferredAngleDeg ?? 0;
      const rad = toRad(fallbackAngle);
      const localCenter = rotateOffset(startDist * Math.cos(rad), startDist * Math.sin(rad), -rotationDeg);
      return { offsetX: localCenter.x - boxW / 2, offsetY: localCenter.y + boxH / 2 };
    };

    const drawFatInfoTable = (
      d: any,
      iconX: number,
      iconY: number,
      safeName: string,
      layerName: string,
      rotationDeg: number = globalTextRotationDeg,
      defaultOffsetX: number = 5,
      defaultOffsetY: number = 3
    ) => {
      d.setActiveLayer(layerName);

      const rowH = 3.5;
      const th = 1.3;
      const w1 = 18;
      const w2 = 3;
      const w3 = 12;
      const totalW = w1 + w2 + w3;
      const totalH = rowH * 3;

      const cy = -2.3;

      let preferredAngleDeg: number | null = null;
      const outsidePoint = projectPointOutsidePolygons(iconX, iconY, greenBoundaryPolygons, 2);
      if (outsidePoint) {
        const worldDx = outsidePoint.x - iconX;
        const worldDy = outsidePoint.y - iconY;
        preferredAngleDeg = (Math.atan2(worldDy, worldDx) * 180) / Math.PI;
      }

      const { offsetX, offsetY } = findNearestClearBoxOffset(
        iconX, iconY, totalW, totalH, rotationDeg, preferredAngleDeg, greenBoundaryPolygons
      );

      const anchorOff = rotateOffset(offsetX, offsetY, rotationDeg);
      const anchorX = iconX + anchorOff.x;
      const anchorY = iconY + anchorOff.y;

      const rp = (dx: number, dy: number) => {
        const rot = rotateOffset(dx, dy, rotationDeg);
        return { x: anchorX + rot.x, y: anchorY + rot.y };
      };

      const p1 = rp(0, 0);
      const p2 = rp(totalW, 0);
      const p3 = rp(totalW, -totalH);
      const p4 = rp(0, -totalH);
      // @ts-ignore
      d.drawPolyline([[p1.x, p1.y], [p2.x, p2.y], [p3.x, p3.y], [p4.x, p4.y]], true);

      for (let i = 1; i <= 2; i++) {
         const l1 = rp(0, -i * rowH);
         const l2 = rp(totalW, -i * rowH);
         d.drawLine(l1.x, l1.y, l2.x, l2.y);
      }

      const v1a = rp(w1, -rowH);
      const v1b = rp(w1, -totalH);
      d.drawLine(v1a.x, v1a.y, v1b.x, v1b.y);

      const v2a = rp(w1 + w2, -rowH);
      const v2b = rp(w1 + w2, -totalH);
      d.drawLine(v2a.x, v2a.y, v2b.x, v2b.y);

      const nameW = safeName.length * th * CHAR_WIDTH_FACTOR;
      const t1 = rp((totalW - nameW)/2, cy);
      d.drawText(t1.x, t1.y, th, rotationDeg, safeName);

      const t2a = rp(1.5, -rowH + cy);
      d.drawText(t2a.x, t2a.y, th, rotationDeg, "DISTANCE_TO");
      const t2b = rp(w1 + 1, -rowH + cy);
      d.drawText(t2b.x, t2b.y, th, rotationDeg, ":");
      const t2c = rp(w1 + w2 + 1.5, -rowH + cy);
      d.drawText(t2c.x, t2c.y, th, rotationDeg, ".. m");

      const t3a = rp(1.5, -rowH*2 + cy);
      d.drawText(t3a.x, t3a.y, th, rotationDeg, "Power @1490 nm");
      const t3b = rp(w1 + 1, -rowH*2 + cy);
      d.drawText(t3b.x, t3b.y, th, rotationDeg, ":");
      const t3c = rp(w1 + w2 + 1.5, -rowH*2 + cy);
      d.drawText(t3c.x, t3c.y, th, rotationDeg, "... dBm");

      const localMinX = Math.min(0, totalW);
      const localMaxX = Math.max(0, totalW);
      const localMinY = Math.min(0, -totalH);
      const localMaxY = Math.max(0, -totalH);
      const nearestLocalX = clampVal(0, offsetX + localMinX, offsetX + localMaxX);
      const nearestLocalY = clampVal(0, offsetY + localMinY, offsetY + localMaxY);
      const nearestOff = rotateOffset(nearestLocalX, nearestLocalY, rotationDeg);
      const connX = iconX + nearestOff.x;
      const connY = iconY + nearestOff.y;
      d.setActiveLayer(layerName);
      d.drawLine(iconX, iconY, connX, connY);

      const centerOffset = rotateOffset(offsetX + totalW/2, offsetY - totalH/2, rotationDeg);
      placedLabelCircles.push({ cx: iconX + centerOffset.x, cy: iconY + centerOffset.y, r: Math.max(totalW, totalH)/2 + 2 });
    };

    const drawIcon = (d: any, x: number, y: number, rawName: string) => {
       const safeName = sanitizeDxfText(String(rawName ?? "").trim()) || "Unnamed";
       const name = safeName.toLowerCase();

       if (isHouseNumberName(safeName, name)) {
          drawHouseMarker(d, x, y, safeName);
          return;
       }

       const iconRadius = getIconRadiusForName(name);
       const adjustedPos = findClearIconPosition(x, y, iconRadius);
       x = adjustedPos.x;
       y = adjustedPos.y;

       let textX = x + 4;
       let textY = y - 2;
       let useDashSplitLabel = false;
       let isVerticalPoleLabel = false;
       let fatLabelLayer: string | null = null;
       let isSlack = false;

       if (name.includes("odc") || name.includes("fat")) {
           const isODC = name.includes("odc") && !name.includes("fat");

           if (isODC) {
               const w = 8.4, h = 4.79, mw = 7.7, mh = 4.15, iw = 7.0, ih = 3.5;
               const border = 0.12;
               drawRectangle(d, x - w, y - h, x + w, y + h, border);
               drawRectangle(d, x - mw, y - mh, x + mw, y + mh, border);
               drawRectangle(d, x - iw, y - ih, x + iw, y + ih, border);
               drawBoldText(d, x - 3.5, y - 2, 4.71, 0, "ODC");
               textX = x + 10;
               useDashSplitLabel = true;
           } else {
               const layerName = getFatLayer(safeName);
               d.setActiveLayer(layerName);
               const w = 4.0, h = 1.5;
               const border = 0.1;
               drawRectangle(d, x - w, y - h, x + w, y + h, border);
               drawRectangle(d, x - (w - 0.3), y - (h - 0.3), x + (w - 0.3), y + (h - 0.3), border);

               d.setActiveLayer("APD_FAT_YELLOW");
               // @ts-ignore
               d.drawFace(
                   x - 3.2, y + 0.8, 0,
                   x - 1.8, y, 0,
                   x - 3.2, y - 0.8, 0,
                   x - 3.2, y - 0.8, 0
               );

               d.setActiveLayer("APD_Label");
               drawBoldText(d, x - 1, y - 0.75, 1.8, 0, "16");

               textX = x + 5;
               useDashSplitLabel = true;
               fatLabelLayer = layerName;
           }
       } else if (name.includes("olt")) {
           d.drawArc(x, y, 2.7, 0, 360);
           d.drawLine(x - 7.07, y - 1.16, x - 7.07, y + 1.05);
           d.drawLine(x - 8.30, y - 1.86, x - 8.30, y + 1.75);
           d.drawLine(x - 8.64, y - 2.06, x - 8.64, y + 1.95);
           d.drawLine(x - 7.07, y, x, y);
           textX = x + 4;
       } else if (name.includes("odp") || name.includes("fdt")) {
           const border = 0.08;
           drawRectangle(d, x - 3.33, y - 1.895, x + 3.33, y + 1.895, border);
           drawRectangle(d, x - 3.05, y - 1.64, x + 3.05, y + 1.64, border);
           drawRectangle(d, x - 2.775, y - 1.385, x + 2.775, y + 1.385, border);
           drawBoldText(d, x - 1.5, y - 0.9, 1.85, 0, "FDT");
           textX = x + 4;
           useDashSplitLabel = true;
       } else if (name.includes("otb")) {
           drawRectangle(d, x - 2.8, y - 1.9, x + 2.8, y + 1.9, 0.08);
           drawBoldText(d, x - 1.5, y - 0.8, 1.71, 0, "OTB");
           textX = x + 4;
       } else if (name.includes("uc")) {
           drawBoldText(d, x - 1, y - 0.5, 1, 0, "UC");
           d.drawLine(x - 0.5, y - 0.5, x + 0.5, y + 0.5);
           d.drawLine(x - 0.5, y + 0.5, x + 0.5, y - 0.5);
           textX = x + 3;
       } else if (name.includes("slack")) {
           d.setActiveLayer("APD_SlackHanger");
           const scale = 0.65;
           const pts = [
               [x, y],
               [x + 1.2*scale, y + 1.2*scale],
               [x + 2.5*scale, y + 1.5*scale],
               [x + 3.8*scale, y + 1.2*scale],
               [x + 4.5*scale, y],
               [x + 3.8*scale, y - 1.2*scale],
               [x + 2.5*scale, y - 1.5*scale],
               [x + 1.2*scale, y - 1.2*scale],
               [x, y],
               [x - 1.2*scale, y - 1.2*scale],
               [x - 2.5*scale, y - 1.5*scale],
               [x - 3.8*scale, y - 1.2*scale],
               [x - 4.5*scale, y],
               [x - 3.8*scale, y + 1.2*scale],
               [x - 2.5*scale, y + 1.5*scale],
               [x - 1.2*scale, y + 1.2*scale],
               [x, y]
           ];
           // @ts-ignore
           d.drawPolyline(pts, true);
           isSlack = true;
       } else if (name.includes("te") || name.includes("ex") || name.includes("existing")) {
           d.setActiveLayer("APD_Pole_Existing");
           const poleR = 1.8;
           d.drawArc(x, y, poleR, 0, 360);
           const crossOffset = poleR * Math.SQRT1_2;
           d.drawLine(x - crossOffset, y - crossOffset, x + crossOffset, y + crossOffset);
           d.drawLine(x - crossOffset, y + crossOffset, x + crossOffset, y - crossOffset);
           textX = x + 3;
           useDashSplitLabel = true;
           isVerticalPoleLabel = true;
       } else if (name.includes("np9") || name.includes("np7") || name.includes("np")) {
           const layerName = getNewPoleLayer(safeName);
           d.setActiveLayer(layerName);
           const poleR = 1.8;
           d.drawArc(x, y, poleR, 0, 360);

           let topText = layerName === "APD_Pole_New_9M" ? "NP9" : "NP7";
           let botText = "4\"";
           const upperName = safeName.toUpperCase();
           if (upperName.includes("3\"") || upperName.includes("3IN") || upperName.includes("3 IN") || upperName.includes("3'")) {
             botText = "3\"";
           }

           drawBoldText(d, x - 1.2, y + 0.3, 0.9, 0, topText);
           drawBoldText(d, x - 0.5, y - 0.8, 0.9, 0, botText);

           textX = x + 3;
           useDashSplitLabel = true;
           isVerticalPoleLabel = true;
       } else if (name.includes("sto")) {
           drawRectangle(d, x - 1.8, y - 2.6, x + 1.8, y + 2.6, 0.08);
           drawBoldText(d, x - 1, y + 0.5, 1.14, 0, "STO");
           drawBoldText(d, x - 1.5, y - 1, 0.51, 0, "TELKOM");
           textX = x + 3;
       } else {
           const s = 1.5;
           // @ts-ignore
           d.drawPolyline([[x, y + s],[x + s, y],[x, y - s],[x - s, y]], true);
           d.drawLine(x - s, y - s, x + s, y + s);
           d.drawLine(x - s, y + s, x + s, y - s);
           textX = x + 2;
           textY = y + 2;
       }

       if (fatLabelLayer) {
         d.setActiveLayer(fatLabelLayer);
       }

       const iconLabelRotation = isSlack ? 0 : (isVerticalPoleLabel ? POLE_LABEL_ROTATION_DEG : globalTextRotationDeg);

       if (fatLabelLayer) {
         drawFatInfoTable(d, x, y, safeName, fatLabelLayer, iconLabelRotation, 5, 3);
       } else if (useDashSplitLabel) {
         const poleLines = splitPoleNameLines(safeName);
         drawSmartMultilineLabel(d, x, y, 2, poleLines, textX - x, textY - y, iconLabelRotation);
       } else {
         let defOffsetX = textX - x;
         let defOffsetY = textY - y;

         if (isSlack) {
            const textWidth = estimateTextWidth(safeName, 2);
            defOffsetX = -textWidth - 3;
            defOffsetY = -1;
         }

         drawSmartLabel(d, x, y, 2, safeName, defOffsetX, defOffsetY, iconLabelRotation);
       }
    };

    const getFiberCoreCount = (name: string): number | null => {
      const upper = name.toUpperCase();
      const matchSlashTube = upper.match(/(\d+)\s*[\/\-]?\s*\d+\s*T\b/);
      if (matchSlashTube) return parseInt(matchSlashTube[1], 10);
      const matchC = upper.match(/(\d+)\s*C\b/);
      if (matchC) return parseInt(matchC[1], 10);
      const matchCore = upper.match(/(\d+)\s*(?:CORE|INTI)\b/);
      if (matchCore) return parseInt(matchCore[1], 10);
      const knownCoreCounts = [288, 144, 96, 72, 48, 24, 12];
      for (const core of knownCoreCounts) {
        if (new RegExp(`(?<!\\d)${core}(?!\\d)`).test(upper)) return core;
      }
      return null;
    };

    const getCableLayerForName = (name: string): string => {
      const core = getFiberCoreCount(name);
      if (core === null) return "APD_Cable_Default";
      const exact = FIBER_CORE_COLORS.find((c) => c.core === core);
      if (exact) return `APD_Cable_${exact.core}C`;
      let closest = FIBER_CORE_COLORS[0];
      let closestDiff = Math.abs(core - closest.core);
      for (const c of FIBER_CORE_COLORS) {
        const diff = Math.abs(core - c.core);
        if (diff < closestDiff) {
          closest = c;
          closestDiff = diff;
        }
      }
      return `APD_Cable_${closest.core}C`;
    };

    const getApdIconRadius = (category: PlacemarkCategory): number => {
      switch (category) {
        case "fdt": return 3;
        case "fat": return 3;
        case "existing_pole": return 1.8;
        case "new_pole": return 1.8;
        case "joint_closure": return 2;
        case "slack_hanger": return 1.9;
        default: return 1;
      }
    };

    const drawApdPointIcon = (d: any, x: number, y: number, rawName: string, category: PlacemarkCategory) => {
      const safeName = sanitizeDxfText(rawName) || "Unnamed";

      const apdIconRadius = getApdIconRadius(category);
      const adjustedPos = findClearIconPosition(x, y, apdIconRadius);
      x = adjustedPos.x;
      y = adjustedPos.y;

      let textOffsetX = 4;
      let textOffsetY = -2;
      let fatLabelLayer: string | null = null;
      let isSlack = false;

      if (category === "fdt") {
        d.setActiveLayer("APD_FDT");
        drawRectangle(d, x - 3, y - 1.7, x + 3, y + 1.7, 0.1);
        drawBoldText(d, x - 2.2, y - 0.8, 1.6, 0, "FDT");
        textOffsetX = 5;
      } else if (category === "fat") {
        const layerName = getFatLayer(safeName);
        d.setActiveLayer(layerName);
        const w = 4.0, h = 1.5;
        const border = 0.1;
        drawRectangle(d, x - w, y - h, x + w, y + h, border);
        drawRectangle(d, x - (w - 0.3), y - (h - 0.3), x + (w - 0.3), y + (h - 0.3), border);

        d.setActiveLayer("APD_FAT_YELLOW");
        // @ts-ignore
        d.drawFace(
            x - 3.2, y + 0.8, 0,
            x - 1.8, y, 0,
            x - 3.2, y - 0.8, 0,
            x - 3.2, y - 0.8, 0
        );

        d.setActiveLayer("APD_Label");
        drawBoldText(d, x - 1, y - 0.75, 1.8, 0, "16");

        textOffsetX = 5;
        fatLabelLayer = layerName;
      } else if (category === "existing_pole") {
        d.setActiveLayer("APD_Pole_Existing");
        const poleR = 1.8;
        d.drawArc(x, y, poleR, 0, 360);
        const crossOffset = poleR * Math.SQRT1_2;
        d.drawLine(x - crossOffset, y - crossOffset, x + crossOffset, y + crossOffset);
        d.drawLine(x - crossOffset, y + crossOffset, x + crossOffset, y - crossOffset);
        textOffsetX = 3;
      } else if (category === "new_pole") {
        const layerName = getNewPoleLayer(safeName);
        d.setActiveLayer(layerName);
        const poleR = 1.8;
        d.drawArc(x, y, poleR, 0, 360);

        let topText = layerName === "APD_Pole_New_9M" ? "NP9" : "NP7";
        let botText = "4\"";
        const upperName = safeName.toUpperCase();
        if (upperName.includes("3\"") || upperName.includes("3IN") || upperName.includes("3 IN") || upperName.includes("3'")) {
          botText = "3\"";
        }

        drawBoldText(d, x - 1.2, y + 0.3, 0.9, 0, topText);
        drawBoldText(d, x - 0.5, y - 0.8, 0.9, 0, botText);

        textOffsetX = 3;
      } else if (category === "joint_closure") {
        d.setActiveLayer("APD_Closure");
        // @ts-ignore
        d.drawPolyline([[x - 2, y - 1.2], [x, y], [x - 2, y + 1.2]], true);
        // @ts-ignore
        d.drawPolyline([[x + 2, y - 1.2], [x, y], [x + 2, y + 1.2]], true);
        textOffsetX = 4;
      } else if (category === "slack_hanger") {
        d.setActiveLayer("APD_SlackHanger");
        const scale = 0.65;
        const pts = [
            [x, y],
            [x + 1.2*scale, y + 1.2*scale],
            [x + 2.5*scale, y + 1.5*scale],
            [x + 3.8*scale, y + 1.2*scale],
            [x + 4.5*scale, y],
            [x + 3.8*scale, y - 1.2*scale],
            [x + 2.5*scale, y - 1.5*scale],
            [x + 1.2*scale, y - 1.2*scale],
            [x, y],
            [x - 1.2*scale, y - 1.2*scale],
            [x - 2.5*scale, y - 1.5*scale],
            [x - 3.8*scale, y - 1.2*scale],
            [x - 4.5*scale, y],
            [x - 3.8*scale, y + 1.2*scale],
            [x - 2.5*scale, y + 1.5*scale],
            [x - 1.2*scale, y + 1.2*scale],
            [x, y]
        ];
        // @ts-ignore
        d.drawPolyline(pts, true);
        isSlack = true;
      } else {
        d.setActiveLayer("APD_Label");
        d.drawArc(x, y, 1, 0, 360);
        textOffsetX = 3;
      }

      if (fatLabelLayer) {
        d.setActiveLayer(fatLabelLayer);
      }

      const isPoleCategory = category === "existing_pole" || category === "new_pole";

      const labelRotation = isSlack ? 0 : (isPoleCategory ? POLE_LABEL_ROTATION_DEG : globalTextRotationDeg);

      if (fatLabelLayer) {
        drawFatInfoTable(d, x, y, safeName, fatLabelLayer, globalTextRotationDeg, 5, 3);
      } else if (isPoleCategory || category === "fdt") {
        const poleLines = splitPoleNameLines(safeName);
        drawSmartMultilineLabel(d, x, y, 1.8, poleLines, textOffsetX, textOffsetY, labelRotation);
      } else {
        let defOffsetX = textOffsetX;
        let defOffsetY = textOffsetY;

        if (isSlack) {
           const textWidth = estimateTextWidth(safeName, 1.8);
           defOffsetX = -textWidth - 3;
           defOffsetY = -0.9;
        }

        drawSmartLabel(d, x, y, 1.8, safeName, defOffsetX, defOffsetY, labelRotation);
      }
    };

    // ==========================================================
    // DETEKSI PILIHAN MITRA DARI FRONTEND (mitraC : Telkom Akses, mitraA :My Republic, mitraB : Internet Rakyat)
    // ==========================================================
    const tipeMitra = req.body.tipeMitra || 'mitraA';
    let mitraCResult: MitraCResult | null = null;

    if (tipeMitra === 'mitraB') {
        // ==========================================================
        // 🔴 LOGIKA KHUSUS MITRA B (internet rakyat)
        // ==========================================================

        const kamusMitraB: Record<string, { tipe: string, bentuk: string, aci: number, layer: string, sizeIcon: number, sizeLabel: number }> = {
            // --- POINT (NODE) ---
            "Tiang6": { tipe: "point", bentuk: "circle", aci: 2, layer: "POLE_T6", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Tiang7": { tipe: "point", bentuk: "circle", aci: 7, layer: "POLE_T7", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Tiang9": { tipe: "point", bentuk: "circle", aci: 5, layer: "POLE_T9", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Tiang Listrik": { tipe: "point", bentuk: "circle", aci: 30, layer: "POLE_LISTRIK", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Tiang Existing": { tipe: "point", bentuk: "circle", aci: 7, layer: "POLE_EXISTING", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODC 48C": { tipe: "point", bentuk: "triangle", aci: 1, layer: "ODC_48C", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODC 48C Existing": { tipe: "point", bentuk: "triangle", aci: 1, layer: "ODC_EXISTING", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODP Single Splitter": { tipe: "point", bentuk: "triangle", aci: 5, layer: "ODP_SINGLE", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODP Double Splitter": { tipe: "point", bentuk: "triangle", aci: 6, layer: "ODP_DOUBLE", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODP Triple Splitter": { tipe: "point", bentuk: "triangle", aci: 6, layer: "ODP_TRIPLE", sizeIcon: 1.0, sizeLabel: 1.0 },
            "ODP Existing": { tipe: "point", bentuk: "triangle", aci: 5, layer: "ODP_EXISTING", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Coil/Slag": { tipe: "point", bentuk: "spiral", aci: 1, layer: "COIL_SLAG", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Closure": { tipe: "point", bentuk: "stop", aci: 5, layer: "CLOSURE", sizeIcon: 1.0, sizeLabel: 1.0 },
            "Rack Server": { tipe: "point", bentuk: "tv", aci: 2, layer: "RACK_SERVER", sizeIcon: 1.0, sizeLabel: 1.0 },

            // --- LINE (KABEL/JALUR) --- (Note: Size Icon = Ketebalan Garis)
            "HDPE": { tipe: "line", bentuk: "line", aci: 4, layer: "HDPE", sizeIcon: 4.0, sizeLabel: 1.0 },
            "Line Distribusi 1-2-4 Core": { tipe: "line", bentuk: "line", aci: 200, layer: "DIST_1_2_4C", sizeIcon: 3.0, sizeLabel: 1.0 },
            "Line Distribusi 12 Core": { tipe: "line", bentuk: "line", aci: 15, layer: "DIST_12C", sizeIcon: 3.0, sizeLabel: 1.0 },
            "Line Distribusi 24 Core": { tipe: "line", bentuk: "line", aci: 30, layer: "DIST_24C", sizeIcon: 3.0, sizeLabel: 1.0 },
            "Line Distribusi 48 Core": { tipe: "line", bentuk: "line", aci: 5, layer: "DIST_48C", sizeIcon: 3.0, sizeLabel: 1.0 }
        };

        Object.values(kamusMitraB).forEach(style => {
            d.addLayer(style.layer, style.aci, "CONTINUOUS");
        });

        placemarkEntries.forEach(({ placemark: p, folderName }) => {
            const name = getPlacemarkName(p);
            const geoms = collectGeometries(p);

            const searchStr = (folderName + " " + name).toUpperCase();
            let aturanGambar: any = null;

            for (const [key, value] of Object.entries(kamusMitraB)) {
                const keyUpper = key.toUpperCase();
                if (searchStr.includes(keyUpper) ||
                   (keyUpper === "TIANG6" && searchStr.includes("T6")) ||
                   (keyUpper === "TIANG7" && searchStr.includes("T7")) ||
                   (keyUpper === "TIANG9" && searchStr.includes("T9"))) {
                    aturanGambar = value;
                    break;
                }
            }

            geoms.forEach((g) => {
                if (aturanGambar) {
                    d.setActiveLayer(aturanGambar.layer);
                    const s = aturanGambar.sizeIcon;
                    const l = aturanGambar.sizeLabel;

                    if (g.kind === "Point" && aturanGambar.tipe === "point") {
                        const coords = g.coordinates.trim().split(",");
                        if (coords.length >= 2) {
                            const prj = projKml(parseFloatVal(coords[0]) || 0, parseFloatVal(coords[1]) || 0);

                            if (aturanGambar.bentuk === "circle") {
                                d.drawArc(prj.x, prj.y, s, 0, 360);
                            }
                            else if (aturanGambar.bentuk === "triangle") {
                                // @ts-ignore
                                d.drawPolyline([[prj.x-s, prj.y-s], [prj.x, prj.y+s], [prj.x+s, prj.y-s], [prj.x-s, prj.y-s]], true);
                            }
                            else if (aturanGambar.bentuk === "stop") {
                                // @ts-ignore
                                d.drawPolyline([[prj.x-(s*0.5), prj.y-s], [prj.x-s, prj.y-(s*0.5)], [prj.x-s, prj.y+(s*0.5)], [prj.x-(s*0.5), prj.y+s], [prj.x+(s*0.5), prj.y+s], [prj.x+s, prj.y+(s*0.5)], [prj.x+s, prj.y-(s*0.5)], [prj.x+(s*0.5), prj.y-s], [prj.x-(s*0.5), prj.y-s]], true);
                                d.drawLine(prj.x-s, prj.y-s, prj.x+s, prj.y+s);
                            }
                            else if (aturanGambar.bentuk === "spiral") {
                                d.drawArc(prj.x, prj.y, s*0.4, 0, 360);
                                d.drawArc(prj.x, prj.y, s*0.8, 0, 360);
                                d.drawArc(prj.x, prj.y, s*1.2, 0, 360);
                            }
                            else if (aturanGambar.bentuk === "tv") {
                                // @ts-ignore
                                d.drawPolyline([[prj.x-s, prj.y-(s*0.8)], [prj.x+s, prj.y-(s*0.8)], [prj.x+s, prj.y+s], [prj.x-s, prj.y+s], [prj.x-s, prj.y-(s*0.8)]], true);
                                d.drawLine(prj.x-(s*0.6), prj.y-(s*0.8), prj.x-(s*0.8), prj.y-(s*1.2));
                                d.drawLine(prj.x+(s*0.6), prj.y-(s*0.8), prj.x+(s*0.8), prj.y-(s*1.2));
                            }

                            d.drawText(prj.x + (s*1.5), prj.y - (l*0.5), l, 0, name);
                        }
                    }
                    else if ((g.kind === "LineString" || g.kind === "Polygon") && aturanGambar.tipe === "line") {
                        const rawCoords = g.coordinates.trim().split(/\s+/);
                        const pts: [number, number][] = rawCoords.map((c: string) => {
                           const parts = c.split(",");
                           const prj = projKml(parseFloatVal(parts[0]) || 0, parseFloatVal(parts[1]) || 0);
                           return [prj.x, prj.y];
                        });

                        if (pts.length > 1) {
                           const closed = g.kind === "Polygon";
                           // @ts-ignore
                           d.drawPolyline(pts, closed);
                        }
                    }
                } else {
                    if (g.kind === "Point") {
                        const coords = g.coordinates.trim().split(",");
                        if (coords.length >= 2) {
                            const prj = projKml(parseFloatVal(coords[0]) || 0, parseFloatVal(coords[1]) || 0);
                            d.setActiveLayer("KML_Default");
                            d.drawArc(prj.x, prj.y, 1.0, 0, 360);
                            d.drawText(prj.x + 1.5, prj.y - 0.5, 1.0, 0, name);
                        }
                    }
                }
            });
        });

    } else if (tipeMitra === 'mitraC') {
        // ==========================================================
        // 🟢 MITRA C (Telkom Akses)
        //   * Jalur: biru = utama, kuning = cabang dari UC
        //   * Simbol ODC / ODP (NEW solid, EXISTING outline) / UC + label lengkap
        // ==========================================================
        mitraCResult = drawMitraC({
            d,
            root: jsonObj.kml || jsonObj,
            projKml,
            collectGeometries,
            getPlacemarkName,
        });

    } else {
        // 🔵 MITRA A (KODE LAMA ANDA YANG SUDAH FIX)

        placemarkEntries.forEach(({ placemark: p, isHomepass, category }) => {
          if (!isHomepass) return;
          const name = getPlacemarkName(p);
          collectGeometries(p).forEach((g) => {
            if (g.kind !== "Point") return;
            const coords = g.coordinates.trim().split(",");
            if (coords.length < 2) return;
            const prj = projKml(parseFloatVal(coords[0]) || 0, parseFloatVal(coords[1]) || 0);
            drawHouseMarker(d, prj.x, prj.y, name, category);
          });
        });


    placemarkEntries.forEach(({ placemark: p, isHomepass, category }) => {
      if (isHomepass) return;
      const name = getPlacemarkName(p);
      const geoms = collectGeometries(p);

      geoms.forEach((g) => {
        if (g.kind === "Point") {
          const coords = g.coordinates.trim().split(",");
          if (coords.length >= 2) {
            const prj = projKml(parseFloatVal(coords[0]) || 0, parseFloatVal(coords[1]) || 0);
            if (
              category === "fdt" ||
              category === "fat" ||
              category === "existing_pole" ||
              category === "new_pole" ||
              category === "joint_closure" ||
              category === "slack_hanger"
            ) {
              drawApdPointIcon(d, prj.x, prj.y, name, category);
            } else {
              d.setActiveLayer("KML_Points");
              drawIcon(d, prj.x, prj.y, name);
            }
          }
          return;
        }

        const rawCoords = g.coordinates.trim().split(/\s+/);
        const pts: [number, number][] = rawCoords.map((c: string) => {
           const parts = c.split(",");
           const prj = projKml(parseFloatVal(parts[0]) || 0, parseFloatVal(parts[1]) || 0);
           return [prj.x, prj.y];
        });

        if (pts.length > 1) {
           const closed = g.kind === "Polygon";

           if (category === "cable" || category === "cable_subfeeder") {
              d.setActiveLayer(getCableLayerForName(name));
              // @ts-ignore
              d.drawPolyline(pts, closed);
              return;
           }
           if (category === "sling_wire") {
              d.setActiveLayer("APD_SlingWire");
              // @ts-ignore
              d.drawPolyline(pts, closed);
              return;
           }
           if (category === "fat_boundary") {
              d.setActiveLayer("APD_FAT_Boundary");
              // @ts-ignore
              d.drawPolyline(pts, closed);
              drawSmartLabel(d, pts[0][0], pts[0][1], 1.4, sanitizeDxfText(name), 0, 2, globalTextRotationDeg);
              return;
           }
           if (category === "boundary_cluster") {
              d.setActiveLayer("APD_BoundaryCluster");
              // @ts-ignore
              d.drawPolyline(pts, closed);
              drawSmartLabel(d, pts[0][0], pts[0][1], 1.6, sanitizeDxfText(name), 0, 2, globalTextRotationDeg);
              return;
           }

           const upperName = name.toUpperCase();
           let layerSet = false;
           for (let i = 1; i <= 12; i++) {
              const code = `D.${i.toString().padStart(2, '0')}`;
              if (upperName.includes(code)) {
                 d.setActiveLayer(`KML_${code}`);
                 layerSet = true;
                 break;
              }
           }
           if (!layerSet) {
               const matchSuffix = upperName.match(/(\d{2})$/);
               if (matchSuffix) {
                  const codeStr = `D.${matchSuffix[1]}`;
                  const num = parseInt(matchSuffix[1], 10);
                  if (num >= 1 && num <= 12) {
                     d.setActiveLayer(`KML_${codeStr}`);
                     layerSet = true;
                  }
               }
           }
           if (!layerSet) d.setActiveLayer("KML_Default");

           // @ts-ignore
           d.drawPolyline(pts, closed);
        }
      });
    });
  }

    if (tipeMitra === "mitraC") {
      type SchematicNode = {
        name: string;
        kind: "ODC" | "ODP" | "UC";
        lon: number;
        lat: number;
        isEks: boolean;
      };
      type SchematicRoute = { coords: [number, number][]; isEks: boolean };
      type SchematicCableRoute = { coords: [number, number][]; name: string; isEks: boolean };

      const schematicNodes: SchematicNode[] = [];
      const schematicRoutes: SchematicRoute[] = [];
      const schematicCableRoutes: SchematicCableRoute[] = [];

      placemarkEntries.forEach(({ placemark, folderName }) => {
        const rawName = getPlacemarkName(placemark);
        const searchName = `${folderName || ""} ${rawName}`.toUpperCase();
        const upperFolderName = (folderName || "").toUpperCase();
        const isNonSegment = /NON[\s-]*SEGMEN/.test(upperFolderName);
        const isSegment = !isNonSegment && /(?:^|[^A-Z])SEGMEN(?:$|[^A-Z])/.test(upperFolderName);
        const isEks = /EKS|EXISTING/.test(searchName);

        collectGeometries(placemark).forEach((geometry) => {
          if ((isNonSegment || isSegment) && geometry.kind === "LineString") {
            const coords = geometry.coordinates.trim().split(/\s+/).map((token) => {
              const [lonRaw, latRaw] = token.split(",");
              const lon = parseFloatVal(lonRaw);
              const lat = parseFloatVal(latRaw);
              return lon !== null && lat !== null ? [lon, lat] as [number, number] : null;
            }).filter((point): point is [number, number] => point !== null);
            if (coords.length > 1) {
              if (isNonSegment) schematicRoutes.push({ coords, isEks });
              else if (rawName.trim() && rawName.trim() !== "Unnamed") {
                schematicCableRoutes.push({ coords, name: rawName.trim(), isEks });
              }
            }
            return;
          }

          if (geometry.kind !== "Point" || isNonSegment) return;
          const [lonRaw, latRaw] = geometry.coordinates.trim().split(",");
          const lon = parseFloatVal(lonRaw);
          const lat = parseFloatVal(latRaw);
          if (lon === null || lat === null) return;

          let kind: SchematicNode["kind"] | null = null;
          if (/\bODC\b/.test(searchName)) kind = "ODC";
          else if (/\b(UC|CLOSURE|SPLICE)\b|\bAS-|\bJB\b/.test(searchName)) kind = "UC";
          else if (/\b(ODP|FAT|FDT)\b/.test(searchName)) kind = "ODP";
          if (!kind) return;

          schematicNodes.push({
            name: rawName.replace(/\(?NEW\)?|\(?EXISTING\)?|\(?EKS\)?/ig, "").trim(),
            kind,
            lon,
            lat,
            isEks,
          });
        });
      });

      const distanceMeters = (a: [number, number], b: [number, number]) => {
        const toRad = (degrees: number) => degrees * Math.PI / 180;
        const dLat = toRad(b[1] - a[1]);
        const dLon = toRad(b[0] - a[0]);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      };

      const routePosition = (node: SchematicNode, route: SchematicRoute, maxDistance = 40) => {
        const points = route.coords.map(([lon, lat]) => projKml(lon, lat));
        const target = projKml(node.lon, node.lat);
        let walked = 0;
        let nearestDistance = Infinity;
        let nearestPosition = 0;

        for (let index = 0; index < points.length - 1; index++) {
          const start = points[index];
          const end = points[index + 1];
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const length = Math.hypot(dx, dy);
          const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / length ** 2));
          const distance = Math.hypot(target.x - (start.x + fraction * dx), target.y - (start.y + fraction * dy));
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPosition = walked + fraction * length;
          }
          walked += length;
        }

        return nearestDistance <= maxDistance ? nearestPosition : null;
      };

      const cableNamesBetweenNodes: { start: SchematicNode; end: SchematicNode; name: string }[] = [];
      schematicCableRoutes.forEach((route) => {
        const positioned = schematicNodes
          .filter((node) => node.kind === "ODP")
          .map((node) => ({ node, position: routePosition(node, route, 8) }))
          .filter((entry): entry is { node: SchematicNode; position: number } => entry.position !== null)
          .sort((a, b) => a.position - b.position);
        for (let index = 0; index < positioned.length - 1; index++) {
          const start = positioned[index].node;
          const end = positioned[index + 1].node;
          if (start !== end) cableNamesBetweenNodes.push({ start, end, name: route.name });
        }
      });

      const cableNameBetween = (start: SchematicNode, end: SchematicNode): string | null => {
        const matches = cableNamesBetweenNodes.filter((cable) =>
          (cable.start === start && cable.end === end) || (cable.start === end && cable.end === start)
        );
        const names = [...new Set(matches.map((cable) => cable.name))];
        return names.length > 0 ? names.join("\n") : null;
      };

      const odcNode = schematicNodes.find((node) => node.kind === "ODC") || null;
      const routeOrderedNodes: SchematicNode[] = [];
      const mainRouteNodes: SchematicNode[] = [];
      const branchRoutes: { source: SchematicNode; nodes: SchematicNode[] }[] = [];
      const nearestEndpointNode = (point: [number, number]) => {
        let nearest: SchematicNode | null = null;
        let nearestDistance = Infinity;
        for (const node of schematicNodes) {
          const distance = distanceMeters(point, [node.lon, node.lat]);
          if (distance < nearestDistance) {
            nearest = node;
            nearestDistance = distance;
          }
        }
        return nearestDistance <= 40 ? nearest : null;
      };

      schematicRoutes.forEach((route) => {
        const positioned = schematicNodes
          .map((node) => ({ node, position: routePosition(node, route) }))
          .filter((entry): entry is { node: SchematicNode; position: number } => entry.position !== null);
        if (positioned.length === 0) return;

        const first = route.coords[0];
        const last = route.coords[route.coords.length - 1];
        const firstNode = nearestEndpointNode(first);
        const lastNode = nearestEndpointNode(last);
        const isTerminatingNode = (node: SchematicNode | null): boolean =>
          !!node && (node.kind === "ODC" || node.kind === "UC");
        const sourceNode: SchematicNode | null = isTerminatingNode(firstNode)
          ? firstNode
          : isTerminatingNode(lastNode)
            ? lastNode
            : null;
        const reverse = sourceNode !== null && sourceNode === lastNode;
        positioned.sort((a, b) => reverse ? b.position - a.position : a.position - b.position);

        const routeNodes: SchematicNode[] = [];
        positioned.forEach(({ node }) => {
          if (node.kind !== "ODC" && !routeOrderedNodes.includes(node)) routeOrderedNodes.push(node);
          if (node.kind !== "ODC" && !routeNodes.includes(node)) routeNodes.push(node);
        });

        if (sourceNode?.kind === "UC") {
          if (!mainRouteNodes.includes(sourceNode)) mainRouteNodes.push(sourceNode);
          const branchNodes = routeNodes.filter((node) => node !== sourceNode);
          if (branchNodes.length > 0) branchRoutes.push({ source: sourceNode, nodes: branchNodes });
        } else {
          routeNodes.forEach((node) => {
            if (!mainRouteNodes.includes(node)) mainRouteNodes.push(node);
          });
        }
      });

      const allDistributionNodes = schematicNodes.filter((node) => node.kind !== "ODC");
      const distributionNodes = mainRouteNodes.length > 0
        ? mainRouteNodes
        : routeOrderedNodes.length > 0 ? routeOrderedNodes : allDistributionNodes;
      const odc = odcNode || {
        name: "ODC-CRM-FAA",
        kind: "ODC" as const,
        lon: 0,
        lat: 0,
        isEks: false,
      };

      const blueNodes = distributionNodes;
      const nodeSpacing = 105;
      const textScale = 4.2;
      const lineSpace = 6.5;
      const mapPadLon = (maxLon - minLon) * 0.1 || 0.002;
      const mapPadLat = (maxLat - minLat) * 0.1 || 0.002;
      const mapRightX = maxLon !== -Infinity && centerLat !== Infinity
        ? projKml(maxLon + mapPadLon, centerLat).x
        : offsetXMeters;
      const mapBottomY = minLon !== Infinity && centerLat !== Infinity
        ? projKml(centerLon, minLat - mapPadLat).y
        : offsetYMeters;
      const frameWidthMm = 1703.19564246596;
      const frameHeightMm = 1468.65361414599;
      const frameMarginMm = 35;
      const frameX = mapRightX + 500;
      const frameY = mapBottomY;
      const schematicBaseX = 200;
      const odcX = schematicBaseX + 145;
      const odcY = 1120;
      const stoX = odcX + 290;
      const tier1Y = odcY - 180;
      const tier2Y = odcY - 330;
      const firstNodeX = schematicBaseX;
      const localLowestY = tier2Y - Math.max(0, branchRoutes.length - 1) * 150 - 20;
      const localLeftX = Math.min(firstNodeX - 50, odcX - 30);
      const branchRightX = branchRoutes.reduce((maxX, branch, branchIndex) => {
        const sourceIndex = blueNodes.indexOf(branch.source);
        const branchX = firstNodeX + Math.max(0, sourceIndex) * nodeSpacing;
        const branchLaneX = branchX + 24 + branchIndex * 12;
        return Math.max(maxX, branchLaneX + 45 + Math.max(0, branch.nodes.length - 1) * nodeSpacing + 140);
      }, firstNodeX);
      const localRightX = Math.max(
        stoX + 100,
        firstNodeX + Math.max(0, blueNodes.length - 1) * nodeSpacing + 140,
        branchRightX
      );
      const localBottomY = localLowestY;
      const localTopY = odcY + 60;
      const fitScale = Math.min(
        1,
        (frameWidthMm - frameMarginMm * 2) / (localRightX - localLeftX),
        (frameHeightMm - frameMarginMm * 2) / (localTopY - localBottomY)
      );
      const contentOffsetX = (frameWidthMm - (localRightX - localLeftX) * fitScale) / 2;
      const contentOffsetY = (frameHeightMm - (localTopY - localBottomY) * fitScale) / 2;
      const toWorld = (x: number, y: number) => ({
        x: frameX + contentOffsetX + (x - localLeftX) * fitScale,
        y: frameY + contentOffsetY + (y - localBottomY) * fitScale,
      });
      const schematicLine = (x1: number, y1: number, x2: number, y2: number) => {
        const start = toWorld(x1, y1);
        const end = toWorld(x2, y2);
        d.drawLine(start.x, start.y, end.x, end.y);
      };
      const schematicPolyline = (points: [number, number][], closed: boolean) => {
        d.drawPolyline(points.map(([x, y]) => {
          const point = toWorld(x, y);
          return [point.x, point.y];
        }), closed);
      };
      const schematicText = (x: number, y: number, height: number, rotation: number, text: string) => {
        const point = toWorld(x, y);
        d.drawText(point.x, point.y, height * fitScale, rotation, text);
      };
      // Label multi-baris memakai TEXT biasa (bukan MTEXT) agar pasti tampil di semua viewer.
      // Baris pertama paling atas; blok diratakan terhadap centerY (koordinat lokal skema).
      const schematicMultiline = (
        lines: string[],
        x: number,
        centerY: number,
        spacing: number,
        hAlign: "left" | "center"
      ) => {
        lines.forEach((line, i) => {
          const p = toWorld(x, centerY + ((lines.length - 1) / 2 - i) * spacing);
          d.drawText(p.x, p.y, textScale * fitScale, 0, line, hAlign, "middle");
        });
      };
      const wrapCableName = (name: string, maxLength: number): string[] => {
        const lines: string[] = [];
        name.replace(/<br\s*\/?>/gi, "\n").split(/\r?\n/).forEach((paragraph) => {
          const words = paragraph.split(/\s+/).filter(Boolean);
          let line = "";
          words.forEach((word) => {
            while (word.length > maxLength) {
              if (line) {
                lines.push(line);
                line = "";
              }
              lines.push(word.slice(0, maxLength));
              word = word.slice(maxLength);
            }
            if (line && line.length + word.length + 1 > maxLength) {
              lines.push(line);
              line = "";
            }
            line = line ? `${line} ${word}` : word;
          });
          if (line) lines.push(line);
        });
        return lines;
      };
      const drawCableName = (name: string, x: number, cableY: number, availableWidth: number) => {
        const maxLength = Math.max(1, Math.floor(availableWidth / (textScale * 0.6)));
        const lines = wrapCableName(name, maxLength);
        if (lines.length === 0) return;

        d.setActiveLayer("MC_SCHEM_TEXT");
        schematicMultiline(lines, x, cableY + 18, lineSpace, "center");
      };
      const drawCableNameBetween = (
        startNode: SchematicNode,
        endNode: SchematicNode,
        startX: number,
        endX: number,
        y: number
      ) => {
        if (startNode.kind !== "ODP" || endNode.kind !== "ODP") return;
        const cableName = cableNameBetween(startNode, endNode);
        if (!cableName) return;
        const clearWidth = Math.max(0, Math.abs(endX - startX) - 38);
        if (clearWidth <= 0) return;
        drawCableName(cableName, (startX + endX) / 2, y, clearWidth);
      };

      drawingAddSchematicLayers();
      d.addLayer("MC_SCHEM_BORDER", 7, "CONTINUOUS");
      d.setActiveLayer("MC_SCHEM_BORDER");
      d.drawPolyline([
        [frameX, frameY],
        [frameX + frameWidthMm, frameY],
        [frameX + frameWidthMm, frameY + frameHeightMm],
        [frameX, frameY + frameHeightMm],
      ], true);

      function drawingAddSchematicLayers() {
        d.addLayer("MC_SCHEM_TEXT", 7, "CONTINUOUS");
        d.addLayer("MC_SCHEM_LINE_BLUE", 5, "CONTINUOUS");
        d.addLayer("MC_SCHEM_LINE_YELLOW", 2, "CONTINUOUS");
        d.addLayer("MC_SCHEM_LINE_WHITE", 7, "CONTINUOUS");
        d.addLayer("MC_SCHEM_SYMBOL", 7, "CONTINUOUS");
      }

      d.setActiveLayer("MC_SCHEM_SYMBOL");
      schematicPolyline([[odcX, odcY + 35], [odcX - 25, odcY], [odcX + 25, odcY], [odcX, odcY + 35]], true);
      schematicPolyline([[odcX, odcY + 29], [odcX - 19, odcY + 3], [odcX + 19, odcY + 3], [odcX, odcY + 29]], true);
      schematicLine(odcX, odcY + 3, odcX, odcY + 29);
      schematicLine(odcX - 9.5, odcY + 16, odcX + 19, odcY + 3);
      schematicLine(odcX + 9.5, odcY + 16, odcX - 19, odcY + 3);
      d.setActiveLayer("MC_SCHEM_TEXT");
      {
        const odcLines = [odc.name];
        if (odcNode) odcLines.push(`${odc.lat.toFixed(6)}*`, `${odc.lon.toFixed(6)}*`);
        schematicMultiline(odcLines, odcX + 35, odcY + 22 - ((odcLines.length - 1) * 7) / 2, 7, "left");
      }

      d.setActiveLayer("MC_SCHEM_SYMBOL");
      const stoSize = 20;
      const stoLeftX = stoX - stoSize * 2.4;
      const stoRightX = stoX + stoSize * 2.4;
      const stoTopY = odcY + stoSize * 1.5;
      const stoCrossBottomY = odcY - stoSize * 0.65;
      const stoBaseY = odcY - stoSize;
      schematicLine(stoLeftX, stoTopY, stoRightX, stoCrossBottomY);
      schematicLine(stoLeftX, stoTopY - 6, stoRightX, stoCrossBottomY - 6);
      schematicLine(stoLeftX, stoCrossBottomY, stoRightX, stoTopY);
      schematicLine(stoLeftX, stoCrossBottomY - 6, stoRightX, stoTopY - 6);
      schematicLine(stoLeftX, stoBaseY, stoRightX, stoBaseY);
      schematicLine(stoLeftX, stoBaseY + 6, stoRightX, stoBaseY + 6);
      d.setActiveLayer("MC_SCHEM_TEXT");
      schematicText(stoX + stoSize + 10, odcY + 5, textScale, 0, "STO. _________");

      d.setActiveLayer("MC_SCHEM_LINE_WHITE");
      const feederY = odcY - 30;
      schematicLine(odcX + 6, odcY, odcX + 6, feederY);
      schematicLine(odcX + 6, feederY, stoX, feederY);
      schematicLine(stoX, feederY, stoX, odcY - stoSize);
      d.setActiveLayer("MC_SCHEM_TEXT");
      schematicText(odcX + 70, feederY + 10, textScale + 1, 0, "CRM-FE-12-01-14");
      schematicText(odcX + 80, feederY - 5, textScale + 1, 0, "AC-OF-SM-48C");

      const blueY = odcY - 180;
      const blueEndX = firstNodeX + Math.max(0, blueNodes.length - 1) * nodeSpacing + 35;
      const drawNodeCableRow = (
        nodes: { node: SchematicNode; x: number }[],
        startX: number,
        endX: number,
        rowY: number,
        layer: "MC_SCHEM_LINE_BLUE" | "MC_SCHEM_LINE_YELLOW"
      ) => {
        const junctionNodes = nodes.filter(({ node }) =>
          node.kind === "ODP" || (layer === "MC_SCHEM_LINE_BLUE" && node.kind === "UC")
        );
        if (junctionNodes.length === 0) {
          d.setActiveLayer(layer);
          schematicLine(startX, rowY, endX, rowY);
          return rowY;
        }

        const cableY = rowY - 35;
        let cableStartX = startX;
        d.setActiveLayer(layer);
        junctionNodes.forEach(({ node, x }) => {
          const leftPortX = x - 6;
          const rightPortX = x + 6;
          const nodeIndex = nodes.findIndex((entry) => entry.node === node);
          const hasFollowingOdp = nodes.slice(nodeIndex + 1).some((entry) => entry.node.kind === "ODP");
          const portY = node.kind === "UC"
            ? rowY - Math.sqrt(12 ** 2 - 6 ** 2)
            : rowY;
          schematicLine(cableStartX, cableY, leftPortX, cableY);
          schematicLine(leftPortX, portY, leftPortX, cableY);
          if (node.kind === "UC" || hasFollowingOdp) {
            schematicLine(rightPortX, portY, rightPortX, cableY);
            cableStartX = rightPortX;
          } else {
            cableStartX = leftPortX;
          }
        });
        if (junctionNodes[junctionNodes.length - 1]?.node.kind !== "ODP") {
          schematicLine(cableStartX, cableY, endX, cableY);
        }
        return cableY;
      };
      const blueCableY = blueNodes.some((node) => node.kind === "ODP" || node.kind === "UC")
        ? blueY - 35
        : blueY;

      d.setActiveLayer("MC_SCHEM_LINE_BLUE");
      schematicLine(odcX - 6, odcY, odcX - 6, odcY - 30);
      schematicLine(odcX - 6, odcY - 30, firstNodeX - 45, odcY - 30);
      schematicLine(firstNodeX - 45, odcY - 30, firstNodeX - 45, blueCableY);
      const blueCableLabelY = drawNodeCableRow(
        blueNodes.map((node, index) => ({ node, x: firstNodeX + index * nodeSpacing })),
        firstNodeX - 45,
        blueEndX,
        blueY,
        "MC_SCHEM_LINE_BLUE"
      );

      const drawSchematicNode = (
        node: SchematicNode,
        x: number,
        y: number,
        index: number
      ) => {
        const tag = node.isEks ? "(EXISTING)" : "(NEW)";
        const coordinates = `${node.lat.toFixed(6)}* ${node.lon.toFixed(6)}*`;
        if (node.kind === "UC") {
          d.setActiveLayer("MC_SCHEM_SYMBOL");
          const radius = 12;
          const circle: [number, number][] = [];
          for (let step = 0; step <= 16; step++) {
            circle.push([x + radius * Math.cos(step * Math.PI / 8), y + radius * Math.sin(step * Math.PI / 8)]);
          }
          schematicPolyline(circle, true);
          schematicLine(x - radius - 3, y + radius + 3, x + radius + 3, y - radius - 3);
          d.setActiveLayer("MC_SCHEM_TEXT");
          const ucLines = [coordinates, `CORE ${index + 1},${index + 2},10,11`, "OS-SM-1 x1", "SC-OF-SM-24 x1", node.name, tag.replace(/[()]/g, "")];
          const ucCenterY = (y + 25) + ((ucLines.length - 1) * lineSpace) / 2;
          schematicMultiline([...ucLines].reverse(), x - 30, ucCenterY, lineSpace, "left");
          return;
        }

        d.setActiveLayer("MC_SCHEM_SYMBOL");
        const triangleWidth = 15;
        const triangleHeight = 22;
        const triangle: [number, number][] = [[x, y + triangleHeight], [x - triangleWidth, y], [x + triangleWidth, y], [x, y + triangleHeight]];
        schematicPolyline(triangle, true);
        if (!node.isEks) {
          // Solid bold (bukan arsiran): polyline lebar awal = alas segitiga, lebar akhir = 0
          const baseW = toWorld(x, y);
          const apexW = toWorld(x, y + triangleHeight);
          // @ts-ignore (startWidth, endWidth)
          d.drawPolyline([[baseW.x, baseW.y], [apexW.x, apexW.y]], false, triangleWidth * 2 * fitScale, 0);
        }
        d.setActiveLayer("MC_SCHEM_TEXT");
        const faaMatch = node.name.match(/FAA\/(\d+)\s+D\.(\d+)/i);
        const faaLabel = faaMatch ? `FAA/D${faaMatch[2].padStart(2, "0")}/${faaMatch[1]}.01` : "-";
        const labels = [coordinates, `TWb0${String(1000 + index).padStart(4, "0")}X${String(10 + index).padStart(2, "0")}`, `CORE ${index + 1}`, "OS-SM-1 x1", "PS-1:8-ODP x1", "ODP-SOLID-8 x1", faaLabel, node.name, tag];
        const odpCenterY = (y + 30) + ((labels.length - 1) * lineSpace) / 2;
        schematicMultiline([...labels].reverse(), x - 35, odpCenterY, lineSpace, "left");
      };

      blueNodes.forEach((node, index) => drawSchematicNode(
        node,
        firstNodeX + index * nodeSpacing,
        blueY,
        index
      ));
      if (odcNode && blueNodes.length > 0) {
        drawCableNameBetween(odcNode, blueNodes[0], odcX, firstNodeX, blueY + 15);
      }
      for (let index = 0; index < blueNodes.length - 1; index++) {
        drawCableNameBetween(
          blueNodes[index],
          blueNodes[index + 1],
          firstNodeX + index * nodeSpacing,
          firstNodeX + (index + 1) * nodeSpacing,
          blueCableLabelY
        );
      }
      const orderedBranches = branchRoutes
        .map((branch) => ({ branch, sourceIndex: blueNodes.indexOf(branch.source) }))
        .filter((entry) => entry.sourceIndex >= 0)
        .sort((a, b) => b.sourceIndex - a.sourceIndex);

      orderedBranches.forEach(({ branch, sourceIndex }, branchIndex) => {
        const { source, nodes } = branch;
        const branchX = firstNodeX + sourceIndex * nodeSpacing;
        const siblingBranches = branchRoutes.filter((candidate) => candidate.source === source);
        const siblingIndex = siblingBranches.indexOf(branch);
        const branchY = tier2Y - branchIndex * 150;
        const branchLaneX = branchX + ((siblingBranches.length - 1) / 2 - siblingIndex) * 4;
        const firstBranchNodeX = branchLaneX + 45;
        const yellowEndX = firstBranchNodeX + Math.max(0, nodes.length - 1) * nodeSpacing + 35;
        const branchCableY = nodes.some((node) => node.kind === "ODP") ? branchY - 35 : branchY;
        d.setActiveLayer("MC_SCHEM_LINE_YELLOW");
        schematicLine(branchX, blueY, branchLaneX, blueY);
        schematicLine(branchLaneX, blueY, branchLaneX, branchCableY);
        const branchCableLabelY = drawNodeCableRow(
          nodes.map((node, index) => ({ node, x: firstBranchNodeX + index * nodeSpacing })),
          branchLaneX,
          yellowEndX,
          branchY,
          "MC_SCHEM_LINE_YELLOW"
        );
        nodes.forEach((node, index) => drawSchematicNode(
          node,
          firstBranchNodeX + index * nodeSpacing,
          branchY,
          blueNodes.length + index
        ));
        drawCableNameBetween(source, nodes[0], branchX, firstBranchNodeX, branchCableLabelY);
        for (let index = 0; index < nodes.length - 1; index++) {
          drawCableNameBetween(
            nodes[index],
            nodes[index + 1],
            firstBranchNodeX + index * nodeSpacing,
            firstBranchNodeX + (index + 1) * nodeSpacing,
            branchCableLabelY
          );
        }
      });
    }

    // ... seluruh logika pemrosesan KML & gambar layer selesai ...

    if (minLon !== Infinity && minLat !== Infinity) {
      const pMin = projKml(minLon, minLat);
      const pMax = projKml(maxLon, maxLat);

      drawTitleBlock({
        d,
        minX: Math.min(pMin.x, pMax.x),
        minY: Math.min(pMin.y, pMax.y),
        maxX: Math.max(pMin.x, pMax.x),
        maxY: Math.max(pMin.y, pMax.y),
        proyek: req.body?.proyek,
        noKontrak: req.body?.noKontrak,
        noSp: req.body?.noSp,
        lokasi: req.body?.lokasi || "STO CERME",
        namaGambar: req.file ? req.file.originalname.replace(/\.kml$/i, '') : "DISTRIBUSI"
      });
    }

    const rawDxf = d.toDxfString();
    const { dxf: dxfContent, fixed: dxfFixed } = sanitizeDxfOutput(rawDxf);
    if (dxfFixed > 0) console.warn(`[DXF] ${dxfFixed} nilai numerik tidak valid (NaN/Infinity) diganti 0. Periksa koordinat KML.`);
    const outputName = `KML_to_DXF_${req.file.originalname.replace(/\.kml$/i, '')}.dxf`;

    res.setHeader("Content-Type", "application/dxf");
    res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
    res.send(dxfContent);
  } catch (error: any) {
    console.error("Terjadi kesalahan saat generate DXF:", error);
    if (!res.headersSent) {
      res.status(500).send("Gagal memproses file KML: " + error.message);
    }
  } finally {
    // Pastikan file upload sementara selalu terhapus (juga saat error)
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {}
    }
  }
});

// ==========================================
// 6. START / STOP SERVER (dipakai Electron main.ts, tetap jalan standalone)
// ==========================================
let httpServer: http.Server | null = null;

/**
 * Menjalankan server Express.
 * - Dipanggil dari electron/main.ts:  const { port } = await startServer();
 * - Jika port 5000 dipakai aplikasi lain, promise akan reject dengan pesan jelas.
 */
export function startServer(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST
): Promise<{ port: number; server: http.Server }> {
  if (httpServer) {
    const addr = httpServer.address() as AddressInfo | null;
    return Promise.resolve({ port: addr ? addr.port : port, server: httpServer });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once("listening", () => {
      httpServer = server;
      const addr = server.address() as AddressInfo;
      console.log(`[BACKEND] Server KML to DXF berjalan di http://${host}:${addr.port}`);
      resolve({ port: addr.port, server });
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} sudah dipakai aplikasi lain. Tutup aplikasi tersebut lalu jalankan ulang.`));
      } else {
        reject(err);
      }
    });
  });
}

/** Menghentikan server (dipanggil saat aplikasi Electron ditutup). */
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    const server = httpServer;
    httpServer = null;
    server.close(() => resolve());
    // @ts-ignore - Node 18.2+
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  });
}

export { app };

// Mode standalone (npm run dev:server / tsx watch server/index.ts):
// langsung jalan. Di dalam Electron, server dijalankan manual oleh main.ts lewat startServer().
if (!IS_ELECTRON) {
  startServer().catch((err) => {
    console.error("[BACKEND] Gagal start server:", err.message);
    process.exit(1);
  });
}