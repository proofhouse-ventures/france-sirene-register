'use strict';
// B12 core logic — pure functions, no Apify dependency. Shared by main.js,
// ingest and tests.
// Scope: INSEE "Base Sirene des entreprises et de leurs établissements
// (SIREN, SIRET)" as published on data.gouv.fr, Licence Ouverte / Open
// Licence 2.0 (Etalab). PERSON-LEVEL SCOPE RULE (Gate-0-lite, 2026-11-22 —
// the research file's Sirene conditions, implemented exactly):
//   1. Legal units whose legal form (catégorie juridique) is in group 1 —
//      personnes physiques, i.e. entrepreneurs individuels (sole traders) —
//      are EXCLUDED at ingest: their registered name is a natural person's
//      name. This is an allow-list on legal-form groups 2–9 (legal persons
//      only); anything outside it is excluded and counted, never shipped
//      silently.
//   2. Legal units flagged non-diffusible by INSEE
//      (statutDiffusionUniteLegale = 'N') are EXCLUDED: INSEE does not
//      authorise their redistribution.
//   3. The source's natural-person columns (nom, nomUsage, prenom1–4,
//      prenomUsuel, pseudonyme, sexe) are NEVER copied into a shipped row —
//      the normaliser does not read them at all. Partially-diffusible units
//      (statut 'P') ship only in their INSEE-masked form: this build never
//      sees an unmasked value because INSEE masks at source.

const SNAPSHOT_DATE = '2026-11-01'; // stock file "01 novembre 2026"
const SOURCE_DATASET = 'Base Sirene des entreprises et de leurs établissements (SIREN, SIRET) — INSEE, via data.gouv.fr';

// Allow-list: first digit of the 4-digit catégorie juridique. The codes
// are INSEE's legal-form nomenclature: sociétés sit in the 5xxx range
// (5499 SARL, 5599 SA, 5710 SAS, 5720 SASU), associations in the 9xxx
// range (9220 association déclarée), public bodies across the 4xxx–8xxx
// ranges. Group 1 (personnes physiques — entrepreneurs individuels) is
// deliberately absent from the allow-list.
const SHIPPED_LEGAL_FORM_GROUPS = new Set(['2', '3', '4', '5', '6', '7', '8', '9']);

// The exact StockUniteLegale header (35 columns, file layout v3.11 —
// verified against the official "dessin de fichier" and asserted at
// ingest; a silent schema drift must never ship as a wrong snapshot).
const UNITE_LEGALE_COLUMNS = [
  'siren', 'statutDiffusionUniteLegale', 'unitePurgeeUniteLegale', 'dateCreationUniteLegale',
  'sigleUniteLegale', 'sexeUniteLegale', 'prenom1UniteLegale', 'prenom2UniteLegale',
  'prenom3UniteLegale', 'prenom4UniteLegale', 'prenomUsuelUniteLegale', 'pseudonymeUniteLegale',
  'identifiantAssociationUniteLegale', 'trancheEffectifsUniteLegale', 'anneeEffectifsUniteLegale',
  'dateDernierTraitementUniteLegale', 'nombrePeriodesUniteLegale', 'categorieEntreprise',
  'anneeCategorieEntreprise', 'dateDebut', 'etatAdministratifUniteLegale', 'nomUniteLegale',
  'nomUsageUniteLegale', 'denominationUniteLegale', 'denominationUsuelle1UniteLegale',
  'denominationUsuelle2UniteLegale', 'denominationUsuelle3UniteLegale', 'categorieJuridiqueUniteLegale',
  'activitePrincipaleUniteLegale', 'nomenclatureActivitePrincipaleUniteLegale', 'nicSiegeUniteLegale',
  'economieSocialeSolidaireUniteLegale', 'societeMissionUniteLegale', 'caractereEmployeurUniteLegale',
  'activitePrincipaleNAF25UniteLegale',
];

// The StockEtablissement columns the siège pass reads (subset of the
// 54-column layout, resolved by header name at ingest — full header is
// asserted too).
const ETABLISSEMENT_COLUMNS = [
  'siren', 'nic', 'siret', 'statutDiffusionEtablissement', 'dateCreationEtablissement',
  'trancheEffectifsEtablissement', 'anneeEffectifsEtablissement', 'activitePrincipaleRegistreMetiersEtablissement',
  'dateDernierTraitementEtablissement', 'etablissementSiege', 'nombrePeriodesEtablissement',
  'complementAdresseEtablissement', 'numeroVoieEtablissement', 'indiceRepetitionEtablissement',
  'dernierNumeroVoieEtablissement', 'indiceRepetitionDernierNumeroVoieEtablissement', 'typeVoieEtablissement',
  'libelleVoieEtablissement', 'codePostalEtablissement', 'libelleCommuneEtablissement',
  'libelleCommuneEtrangerEtablissement', 'distributionSpecialeEtablissement', 'codeCommuneEtablissement',
  'codeCedexEtablissement', 'libelleCedexEtablissement', 'codePaysEtrangerEtablissement',
  'libellePaysEtrangerEtablissement', 'identifiantAdresseEtablissement', 'coordonneeLambertAbscisseEtablissement',
  'coordonneeLambertOrdonneeEtablissement', 'complementAdresse2Etablissement', 'numeroVoie2Etablissement',
  'indiceRepetition2Etablissement', 'typeVoie2Etablissement', 'libelleVoie2Etablissement',
  'codePostal2Etablissement', 'libelleCommune2Etablissement', 'libelleCommuneEtranger2Etablissement',
  'distributionSpeciale2Etablissement', 'codeCommune2Etablissement', 'codeCedex2Etablissement',
  'libelleCedex2Etablissement', 'codePaysEtranger2Etablissement', 'libellePaysEtranger2Etablissement',
  'dateDebut', 'etatAdministratifEtablissement', 'enseigne1Etablissement', 'enseigne2Etablissement',
  'enseigne3Etablissement', 'denominationUsuelleEtablissement', 'activitePrincipaleEtablissement',
  'nomenclatureActivitePrincipaleEtablissement', 'caractereEmployeurEtablissement', 'activitePrincipaleNAF25Etablissement',
];

// Why a raw StockUniteLegale record does not ship; null when it ships.
// Rule order is part of the contract (scripts/verify.py applies the same
// order): non-diffusible first (INSEE forbids redistribution regardless
// of legal form), then personnes physiques, then anything outside the
// allow-list.
function exclusionReason(r) {
  if (r.statutDiffusionUniteLegale === 'N') return 'non_diffusible';
  const cj = (r.categorieJuridiqueUniteLegale || '').trim();
  if (cj.charAt(0) === '1') return 'personne_physique';
  if (!SHIPPED_LEGAL_FORM_GROUPS.has(cj.charAt(0))) return 'unclassified_or_other';
  return null;
}

function shipsUnit(r) {
  return exclusionReason(r) === null;
}

// Parse one CSV record (RFC4180 quoting handled; Sirene fields can contain
// commas and doubled quotes, e.g. denominations).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function csvHeader(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  return parseCsvLine(firstLine).map((h) => h.trim().replace(/^\uFEFF/, ''));
}

// Parse a whole CSV file's text into raw record objects keyed by header
// (small inputs only — fixtures and tooling; the ingest streams instead).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = csvHeader(text);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const rec = {};
    header.forEach((h, i) => { rec[h] = vals[i] !== undefined ? vals[i].trim() : ''; });
    return rec;
  });
}

function emptyToNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toIntOrNull(v) {
  const s = emptyToNull(v);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function yesNoToBool(v) {
  const s = emptyToNull(v);
  if (s === 'O') return true;
  if (s === 'N') return false;
  return null;
}

// French département from a commune (COG) code: first two characters,
// except Corsica (2A/2B) and overseas départements (971–978, three
// characters). Foreign sièges (commune code absent) return null.
function departementFromCommune(codeCommune) {
  const c = emptyToNull(codeCommune);
  if (!c) return null;
  if (c.startsWith('2A') || c.startsWith('2B')) return c.slice(0, 2);
  if (/^9[78]/.test(c)) return c.slice(0, 3);
  return c.slice(0, 2);
}

// Normalise one raw StockUniteLegale record into the clean store shape.
// `siege` is the unit's head-office establishment summary (from
// StockEtablissement, etablissementSiege = true) or null. Returns null for
// excluded units (see the scope rule above). The natural-person columns
// are never read.
function normaliseRecord(r, siege, snapshotDate) {
  if (!shipsUnit(r)) return null;
  const denomination = emptyToNull(r.denominationUniteLegale);
  const usuelles = [
    emptyToNull(r.denominationUsuelle1UniteLegale),
    emptyToNull(r.denominationUsuelle2UniteLegale),
    emptyToNull(r.denominationUsuelle3UniteLegale),
  ].filter(Boolean);
  const creation = emptyToNull(r.dateCreationUniteLegale);
  const cj = (r.categorieJuridiqueUniteLegale || '').trim();
  return {
    siren: r.siren,
    snapshot_date: snapshotDate || SNAPSHOT_DATE,
    name: denomination || usuelles[0] || null,
    denomination,
    denomination_usuelle: usuelles,
    sigle: emptyToNull(r.sigleUniteLegale),
    legal_form_code: cj || null,
    legal_form_group: cj ? cj.charAt(0) : null,
    activity_code: emptyToNull(r.activitePrincipaleUniteLegale),
    activity_code_naf25: emptyToNull(r.activitePrincipaleNAF25UniteLegale),
    creation_date: creation,
    creation_month: creation ? creation.slice(0, 7) : null,
    admin_status: emptyToNull(r.etatAdministratifUniteLegale), // 'A' active, 'C' ceased
    headcount_band: emptyToNull(r.trancheEffectifsUniteLegale),
    headcount_year: toIntOrNull(r.anneeEffectifsUniteLegale),
    enterprise_category: emptyToNull(r.categorieEntreprise),
    employer: yesNoToBool(r.caractereEmployeurUniteLegale),
    ess: yesNoToBool(r.economieSocialeSolidaireUniteLegale),
    association_id: emptyToNull(r.identifiantAssociationUniteLegale),
    siege_siret: siege ? siege.siret : null,
    siege_postal_code: siege ? siege.code_postal : null,
    siege_commune: siege ? siege.commune : null,
    siege_commune_code: siege ? siege.code_commune : null,
    departement: siege ? siege.departement : null,
    siege_country_code: siege ? siege.code_pays_etranger : null,
    source_dataset: SOURCE_DATASET,
  };
}

// Build the siège summary for one StockEtablissement record, or null when
// the record is not a diffusible head office.
function siegeFromEtablissement(e) {
  if (e.etablissementSiege !== 'true') return null;
  if (e.statutDiffusionEtablissement === 'N') return null;
  const codeCommune = emptyToNull(e.codeCommuneEtablissement);
  return {
    siret: emptyToNull(e.siret),
    code_postal: emptyToNull(e.codePostalEtablissement),
    commune: emptyToNull(e.libelleCommuneEtablissement),
    code_commune: codeCommune,
    departement: departementFromCommune(codeCommune),
    code_pays_etranger: emptyToNull(e.codePaysEtrangerEtablissement),
  };
}

function nafDigits(code) {
  return (code || '').replace(/[^0-9]/g, '');
}

// Single-row filter predicate (filterUnits is this, applied to an array).
function matchesFilters(r, input, meta) {
  const legalForm = input.legalForm != null && input.legalForm !== '' ? String(input.legalForm).trim() : null;
  const group = input.legalFormGroup != null && input.legalFormGroup !== '' ? String(input.legalFormGroup).trim().charAt(0) : null;
  const naf = input.nafCode != null && input.nafCode !== '' ? nafDigits(String(input.nafCode)) : null;
  const division = input.nafDivision != null && input.nafDivision !== '' ? String(input.nafDivision).replace(/[^0-9]/g, '').padStart(2, '0') : null;
  const dept = input.departement != null && input.departement !== '' ? String(input.departement).trim().toUpperCase() : null;
  const nameContains = input.nameContains ? String(input.nameContains).toLowerCase() : null;
  const latest = meta ? meta.latest_month : null;
  let status = null;
  if (input.adminStatus) {
    const s = String(input.adminStatus).trim().toLowerCase();
    if (s === 'a' || s === 'active') status = 'A';
    else if (s === 'c' || s === 'ceased' || s === 'closed') status = 'C';
    else status = String(input.adminStatus).trim().toUpperCase();
  }
  if (input.onlyNewThisMonth && (!latest || r.creation_month !== latest)) return false;
  if (input.monthFrom && (!r.creation_month || r.creation_month < input.monthFrom)) return false;
  if (input.monthTo && (!r.creation_month || r.creation_month > input.monthTo)) return false;
  if (legalForm && r.legal_form_code !== legalForm) return false;
  if (group && r.legal_form_group !== group) return false;
  if (naf && !nafDigits(r.activity_code).startsWith(naf)) return false;
  if (division && !nafDigits(r.activity_code).startsWith(division)) return false;
  if (dept && r.departement !== dept) return false;
  if (status && r.admin_status !== status) return false;
  if (nameContains && !(r.name || '').toLowerCase().includes(nameContains)) return false;
  if (input.hasSiege && !r.siege_siret) return false;
  return true;
}

function filterUnits(rows, input, meta) {
  return rows.filter((r) => matchesFilters(r, input, meta));
}

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

function topCounts(map, limit, keyName) {
  return [...map.entries()]
    .map(([k, v]) => ({ [keyName]: k, units: v }))
    .sort((a, b) => b.units - a.units || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, limit);
}

// Streaming analytics accumulator — computeAnalytics(rows) is this applied
// to an array, so the run path can aggregate 13.2M rows in one pass without
// holding them. Output shape is byte-identical to the array version (the
// fixture tests assert it).
function createAnalyticsAccumulator(meta) {
  const byMonth = {};
  const byStatus = {};
  const byGroup = {};
  const byDept = new Map();
  const naf = new Map();
  const divisions = new Map();
  const headcount = {};
  const latest = meta ? meta.latest_month : null;
  const cohortDept = new Map();
  const cohortNaf = new Map();
  let cohortCount = 0;
  let withSiege = 0;
  let total = 0;
  return {
    add(r) {
      total += 1;
      if (r.creation_month) byMonth[r.creation_month] = (byMonth[r.creation_month] || 0) + 1;
      const st = r.admin_status || 'unknown';
      byStatus[st] = (byStatus[st] || 0) + 1;
      const g = r.legal_form_group || 'unknown';
      byGroup[g] = (byGroup[g] || 0) + 1;
      if (r.departement) bump(byDept, r.departement);
      if (r.siege_siret) withSiege += 1;
      if (r.activity_code) {
        const e = naf.get(r.activity_code) || { code: r.activity_code, units: 0 };
        e.units += 1;
        naf.set(r.activity_code, e);
        const div = nafDigits(r.activity_code).slice(0, 2);
        if (div) bump(divisions, div);
      }
      const hb = r.headcount_band || 'unknown';
      headcount[hb] = (headcount[hb] || 0) + 1;
      if (latest && r.creation_month === latest) {
        cohortCount += 1;
        if (r.departement) bump(cohortDept, r.departement);
        if (r.activity_code) bump(cohortNaf, r.activity_code);
      }
    },
    finish() {
      const topNaf = [...naf.values()].sort((a, b) => b.units - a.units || a.code.localeCompare(b.code)).slice(0, 50);
      return {
        rows_analysed: total,
        creations_by_month: byMonth,
        status_breakdown: byStatus,
        by_legal_form_group: byGroup,
        top_departements: topCounts(byDept, 30, 'departement'),
        top_naf_codes: topNaf,
        top_naf_divisions: topCounts(divisions, 30, 'division'),
        headcount_bands: headcount,
        with_siege: withSiege,
        latest_month_cohort: {
          month: latest,
          units: cohortCount,
          top_departements: topCounts(cohortDept, 20, 'departement'),
          top_naf_codes: topCounts(cohortNaf, 20, 'code'),
          definition: 'Legal units whose creation date falls in the snapshot\'s latest creation month — the new-creations cohort of this release. Closure cohorts are visible via admin_status over creation cohorts; a true delta (creations/closures since the previous stock) requires two snapshots and is not claimed in v1.',
        },
        coverage: 'French legal persons only (catégorie juridique groups 2–9) from the INSEE Sirene stock of 1 November 2026, as published on data.gouv.fr under Licence Ouverte 2.0. Entrepreneurs individuels / personnes physiques (legal-form group 1) and INSEE-flagged non-diffusible units are excluded by design (see README). All administrative statuses are included; use the adminStatus filter for active-only views. Siège (head-office) location fields come from the unit\'s head-office establishment in the same stock.',
      };
    },
  };
}

function computeAnalytics(rows, meta) {
  const acc = createAnalyticsAccumulator(meta);
  for (const r of rows) acc.add(r);
  const out = acc.finish();
  out.rows_analysed = rows.length;
  return out;
}

module.exports = {
  SNAPSHOT_DATE,
  SOURCE_DATASET,
  SHIPPED_LEGAL_FORM_GROUPS,
  UNITE_LEGALE_COLUMNS,
  ETABLISSEMENT_COLUMNS,
  exclusionReason,
  shipsUnit,
  parseCsv,
  parseCsvLine,
  csvHeader,
  emptyToNull,
  departementFromCommune,
  normaliseRecord,
  siegeFromEtablissement,
  filterUnits,
  matchesFilters,
  computeAnalytics,
  createAnalyticsAccumulator,
};
