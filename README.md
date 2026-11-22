# France Sirene Register — French Companies, Legal Forms & NAF Analytics

Searchable, programmatic access to France's official company register — the INSEE **Sirene** base — as a complete typed archive of **legal persons**: sociétés, associations, foundations and public bodies, each with its SIREN, legal form (*catégorie juridique*), NAF/APE activity code, creation date, headcount band and head-office (*siège*) location, plus genuinely derived analytics: creations by month, by NAF sector and division, and by département.

Built for the teams that sell to, screen, or study French companies — KYB/compliance teams, B2B data builders, market researchers, and the agents and tools that work for them — inside Apify, where per-result pricing means you pay only for the rows you pull. The register is the same one Pappers, Societe.com and the official *Annuaire des entreprises* are built on; what is different here is the form: the **complete archive in one run**, not a lookup API capped at 10,000 results per search.

## What you get

- **Legal-unit rows** matching your filters (creation month range, latest-month cohort, legal form code or group, NAF/APE code or division, siège département, administrative status, name), each with: SIREN, snapshot date, name and dénominations (current + usuelles), sigle, legal form code and group, NAF/APE activity code (NAF rév. 2 and the NAF25 crosswalk as published), creation date and month, administrative status (A = active, C = ceased), employee headcount band and its reference year, enterprise category, employer and ESS flags, association registration number where applicable, and the head office's SIRET, postal code, commune and département.
- **Derived analytics** (key-value store record `ANALYTICS`): rows analysed, creations by month, status breakdown, counts by legal-form group, top départements, top NAF codes and divisions, headcount-band distribution, and a latest-month cohort summary — all computed over the full filtered set, not a sample.

## Coverage — read this first

- **13,167,791 legal units** from the Sirene stock of **1 November 2026** (files published on data.gouv.fr on 3–5 November 2026; creations as published, from historical records to October 2026). INSEE publishes a new stock monthly; this archive is refreshed on the same cadence, and every row carries its `snapshot_date`.
- **Legal persons only — by design.** *Entrepreneurs individuels* (sole traders, catégorie juridique group 1) are **excluded** — 17,112,433 units in this stock: their registered name is a natural person's name, and this product does not ship person-level records. If you need sole traders, INSEE's own Sirene products are the right source. Units INSEE flags as non-diffusible are likewise never shipped (the public stock contains none), and the source's natural-person columns (names, first names, pseudonyms) are never read into this dataset.
- **The "latest month" is the last complete month before the stock date** — October 2026 (28,370 new legal persons). About 2,000 units carry creation dates in November 2026 or later exactly as INSEE publishes them (advance/scheduled registrations, a handful dated 2027–2028); they are in the archive but never define the cohort. A true delta (creations/closures since the previous stock) needs two snapshots to diff and is **not** claimed in v1; the analytics' status breakdown shows the register's current status mix.
- All administrative statuses are in the archive (active and ceased, exactly as published). Use the `adminStatus` filter for active-only views.
- Head-office location is attached for 13,167,709 of the 13,167,791 units (99.999%); the remainder have no diffusible head-office establishment in the stock and carry null siège fields.

## Data source, licence and attribution

Source dataset: **"Base Sirene des entreprises et de leurs établissements (SIREN, SIRET)"**, Institut national de la statistique et des études économiques (INSEE), published on data.gouv.fr, stock of 1 November 2026, accessed 22 November 2026. *Source : INSEE, base Sirene, stock du 1er novembre 2026, via data.gouv.fr.* Used under the **Licence Ouverte / Open Licence 2.0** (Etalab) — https://www.etalab.gouv.fr/licence-ouverte-open-licence — which permits commercial reuse with attribution of the source and the extract date, as done here.

**Independent tool; not affiliated with INSEE, Etalab or the French State, and not endorsed by them.**

Personal-data handling: the person-level classes named above are excluded at ingest under a hard-coded rule, and the build's verification recomputes the exclusion independently from the source files. What ships is legal-person register data: company and organisation names, legal forms, activity codes, statuses, dates, and head-office locations as published by INSEE.

## Pricing

**US$20 per 1,000 results** (US$0.020 per legal-unit row returned to the dataset), with a free allowance of 250 results. Analytics are delivered to the key-value store and are not metered per row.

## Input

| Field | Meaning |
|---|---|
| `mode` | `rows`, `analytics`, or `both` (default) |
| `monthFrom` / `monthTo` | creation month range as `YYYY-MM` (defaults prefilled to the latest complete month, so a default run returns just the new-creations cohort) |
| `onlyNewThisMonth` | restrict to the snapshot's latest complete creation month |
| `legalForm` | exact 4-digit catégorie juridique code, e.g. `5710` (SAS), `5499` (SARL), `9220` (association déclarée) |
| `legalFormGroup` | first digit of the legal form code (sociétés are `5`, associations are `9`) |
| `nafCode` | prefix match on the NAF/APE activity code; dots ignored (`62.01`, `6201`, `47` all work) |
| `nafDivision` | 2-digit NAF division prefix |
| `departement` | head-office département, e.g. `75`, `69`, `2A`, `971` |
| `adminStatus` | `A` / `active` or `C` / `ceased` |
| `nameContains` | case-insensitive substring match on the unit's name |
| `hasSiege` | only units with a head-office location attached |
| `limit` | max rows returned (default: all matching) |

## Résumé en français

Registre Sirene complet (stock INSEE du 1er novembre 2026, via data.gouv.fr, Licence Ouverte 2.0) : 13 167 791 personnes morales — sociétés, associations, organismes publics — avec SIREN, catégorie juridique, code NAF/APE, date de création, tranche d'effectifs et localisation du siège, plus des statistiques dérivées (créations par mois, par secteur NAF et par département). Les entrepreneurs individuels sont exclus par conception : leur dénomination est le nom d'une personne physique. Outil indépendant, sans affiliation avec l'INSEE.

## Terms

Outputs are derived from the source dataset named above and are provided as-is for business intelligence. Names, statuses, dates and coverage are exactly as published by the source, subject to the scope exclusions in the coverage statement above; check it before relying on any aggregate.
