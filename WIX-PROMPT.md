# Prompt for building the Elias Lab site in Wix

Wix's AI builder takes a short brief, then you refine. So this file has:

- **Part 1** — the brief to paste into Wix AI (keep it short; long prompts get ignored)
- **Part 2** — brand settings to apply once
- **Part 3** — section-by-section content to paste while editing
- **Part 4** — the one piece Wix can't build (the scanner) 

---

# Part 1 · Paste this into Wix AI

> Create a website for a university research laboratory.
>
> **Name:** Elias Lab — Precision Genome Integration
> **Field:** gene therapy and genome engineering
> **Institution:** Biotechnology Engineering Department, Braude College of
> Engineering, Karmiel, Israel
> **Led by:** Dr. Amer Elias, Principal Investigator
>
> The lab engineers site-specific recombinases — enzymes that insert large DNA
> sequences at chosen locations in the human genome without cutting it. This is
> an alternative to CRISPR-style editing, aimed at safer gene therapy for
> hereditary disease and cancer.
>
> **Audience:** fellow scientists, prospective graduate students, and potential
> academic and industry collaborators.
>
> **Tone:** serious, precise, scientific. Confident but not promotional. No
> stock-photo clichés of test tubes or glowing DNA helices.
>
> **Style:** clean and editorial. Warm off-white background, deep teal and
> emerald green accents, generous white space, an elegant serif for headings
> and a clean sans-serif for body text.
>
> **Pages:** a single long homepage with these sections in order —
> Hero · Research Overview · Research Aims · Therapeutic Applications ·
> Publications · News · Team · Collaborations · Lab Services · Join the Lab ·
> Contact.
>
> Also include a prominent header button labelled "Lab Notebook" that links to
> an external URL.

---

# Part 2 · Brand settings (apply once)

### Colours
| Role | Hex |
|---|---|
| Page background | `#f4f1e8` |
| Alternate section background | `#ece7d9` |
| Body text | `#16241f` |
| Secondary text | `#4a5a52` |
| Primary / headings / buttons | `#0c4a44` |
| Dark sections & footer | `#072e2a` |
| Accent | `#10b07e` |
| Bright accent (on dark) | `#1fd197` |
| Secondary accent | `#1d5fd4` |

### Fonts (all available in Wix)
- **Headings:** Fraunces — semi-bold (600)
- **Body:** IBM Plex Sans
- **Small labels / captions:** IBM Plex Mono, uppercase, wide letter-spacing

### Images to upload to Wix Media
| File in this project | Use |
|---|---|
| `assets/logo/elias-lab-logo.png` | site header logo |
| `assets/logos/braude-college.png` | header (beside lab logo) + footer |
| `assets/team/amer-elias.jpg` | Team section — **circular crop, ~150px** |
| `assets/logos/tel-aviv-university.png` etc. (5 files) | Collaborations strip |
| `assets/logo/elias-lab-mark.png` | favicon |

### Layout notes
- Alternate section backgrounds between `#f4f1e8` and `#ece7d9`
- Make **Therapeutic Applications** and **Contact** dark (`#072e2a`) for contrast
- Centre all section headings
- Above each heading, add a small uppercase mono label (the "kicker")

---

# Part 3 · Section content

Copy each block into the matching Wix section.

## Hero
**Heading:** Engineering Integrases for Gene Therapy
*(italicise "Integrases" and give it a teal→green→blue gradient if Wix allows)*

**Body:** Developing novel site-specific recombinases to enable precise,
large-scale DNA insertion into native genomic sites without double-strand
breaks — transforming the landscape of gene therapy and genetic medicine.

**Buttons:** `Explore Research` · `Get in Touch` (mailto: amere@braude.ac.il)

**Three statistics:**
| Number | Label |
|---|---|
| ~40,000 | Native attB sites mapped |
| 0 | Double-strand breaks |
| Multi-kb | Payload integration |

## Research Overview
**Kicker:** RESEARCH OVERVIEW
**Heading:** A New Route into the Genome
**Intro:** Replacing break-and-repair editing with precise, programmable
integration at the genome's own landing sites.

**Box 1 — "The Challenge"** *(tint red)*
Current Limitations in Genome Editing — Traditional genome-editing tools like
CRISPR, ZFNs, and TALENs create double-strand breaks (DSBs) to induce gene
editing. However, they struggle with inserting large DNA sequences at precise
genomic locations and often generate unintended modifications including indels,
off-target effects, and oncogene activation.

**Box 2 — "Our Solution"** *(tint green)*
Tyrosine Site-Specific Integrases — We are developing engineered tyrosine
recombinases — particularly HK022 — that recognize and integrate into native
genomic attachment sites (attB) without creating double-strand breaks. Our
discovery identified approximately 40,000 unique native attB sites across the
human genome, enabling precise, large-scale DNA integration for therapeutic
applications.

**Key Advantages** *(list)*
- **No Double-Strand Breaks:** Eliminates risks of mosaicism and unintended modifications
- **Large DNA Payloads:** Enables integration of multi-kilobase sequences efficiently
- **Mutation-Independent:** Single therapy can treat patients with different mutations in the same gene
- **High Specificity:** Targets native genomic sites with minimal off-target effects
- **Multiplexing Capability:** Multiple genetic payloads integrated simultaneously at distinct loci

## Research Aims — 5 numbered cards
**Kicker:** WHAT WE'RE BUILDING · **Heading:** Research Aims & Objectives

1. **Recombinase Discovery, Engineering & Optimization** — Discover, engineer, and optimize novel tyrosine site-specific recombinases — with the HK022 integrase as our leading model — through metagenomic mining, phage-assisted continuous evolution (PACE), directed and random mutagenesis, and AlphaFold3-guided design to maximize activity and specificity at native human genomic sites.
2. **Gene Therapy for Hereditary Diseases** — Develop precise, double-strand-break-free integration tools to treat a broad range of inherited disorders — restoring gene function through safe-harbor insertion, promoter-trap, and RMCE strategies that work across diverse patient mutations in the same gene.
3. **Gene Therapy for Cancer** — Design recombinase-based approaches for oncology — from tumor-suppressor gene correction to engineered immune-cell therapies — enabling targeted delivery of large, multi-gene payloads.
4. **Cell Line Engineering & Development** — Build engineered and stable cell-line models by integrating defined genetic payloads at chosen loci — supporting reporter systems, therapeutic protein production, and functional research models.
5. **Multiplexed Integration** — Demonstrate simultaneous integration of multiple distinct genetic payloads at different genomic loci in a single event, enabling complex gene-circuit and multi-transgene engineering.

## Therapeutic Applications — 4 cards *(dark background)*
**Kicker:** WHERE IT LEADS · **Heading:** Therapeutic Applications
**Intro:** One precise-integration platform, applied across loss-of-function
disease, cancer, and complex cell engineering.

| Small label | Card title | Text |
|---|---|---|
| Safe-Harbor Integration | Stable Transgene Expression | Targeting well-characterized safe loci (Rosa26, CLYBL, H11) for stable, predictable gene expression. Ideal for restoring gene function in loss-of-function diseases. |
| RMCE Technology | Tumor Suppressor Gene Correction | Precise replacement of mutated BRCA1 and TP53 sequences with healthy wild-type donor DNA. Enables "pan-mutation" therapeutics. |
| Neurodevelopmental Disorders | Haploinsufficiency Correction | Targeting genes like GRIN2B and SHANK3 to restore normal gene dosage in autism spectrum disorders and other neurodevelopmental conditions. |
| Genetic Disease | Cystic Fibrosis & Duchenne Muscular Dystrophy | Large-scale DNA insertion for diseases caused by heterogeneous mutations. One approach benefiting patients with diverse mutations in the same gene. |

## Publications
**Kicker:** SELECTED WORK · **Heading:** Publications
**Intro:** Peer-reviewed research on HK022 integrase engineering and its therapeutic applications.

Layout: year + journal on the left, title/authors/DOI button on the right.
Bold **Elias A** in every author list.

1. **2026 · Cells** — Gene Editing Strategies for Neurological and Mental Disorders: Advances in Delivery, Methodology, and Clinical Translation. *Elias A, Stern S — Cells 15(8):720.* DOI: https://doi.org/10.3390/cells15080720
2. **2020 · Nucleic Acids Research** — HK022 bacteriophage Integrase-mediated RMCE as a potential tool for human gene therapy. *Elias A, Kassis H, Abu Elkader S, Gritsenko N, Nahmad A, Shir H, Younis L, Shannan A, Aihara H, Prag G, Yagil E, Kolot M — 48(22):12804–12816.* DOI: https://doi.org/10.1093/nar/gkaa1140
3. **2018 · Oncotarget** — Anti-cancer binary system activated by bacteriophage HK022 Integrase. *Elias A, Gritsenko N, Gorovits R, Spector I, Prag G, Yagil E, Kolot M — 9:27487–27501.* DOI: https://doi.org/10.18632/oncotarget.25512
4. **2016 · Scientific Reports** — Cancer-specific binary expression system activated in mice by bacteriophage HK022 Integrase. *Elias A, Spector I, Sogolovsky-Bard I, Gritsenko N, Rask L, Mainbakh Y, Zilberstein Y, Yagil E, Kolot M — 6:24971.* DOI: https://doi.org/10.1038/srep24971
5. **2015 · Gene Therapy** — Site promiscuity of coliphage HK022 integrase as a tool for gene therapy. *Kolot M, Malchin N, Elias A, Gritsenko N, Yagil E.* DOI: https://doi.org/10.1038/gt.2015.9

## News — vertical timeline, newest first
**Kicker:** LAB UPDATES · **Heading:** News · **Intro:** Recent milestones from the lab.

- **October 2026 · upcoming** — *The lab opens its doors.* The Elias Lab begins operating in the Biotechnology Engineering Department at Braude College of Engineering, Karmiel — focused on engineering site-specific recombinases for double-strand-break-free gene therapy and cell engineering.
- **19 Apr 2026** — *Review published in Cells.* Our review, "Gene Editing Strategies for Neurological and Mental Disorders," was published in Cells.

## Team
**Kicker:** WHO WE ARE · **Heading:** The Team

**Dr. Amer Elias** — Principal Investigator & Founder
*(circular photo ~150px, LinkedIn icon linking to https://linkedin.com/in/amer-elias-762a0998)*

Dr. Amer Elias is establishing a gene therapy and cell engineering laboratory
dedicated to engineering novel site-specific recombinases for biotechnological
and therapeutic innovation.

With extensive expertise in genome editing, protein engineering, and
translational research, Dr. Elias brings a vision of transforming gene therapy
through precise, DSB-free genome integration strategies.

The laboratory focuses on bridging fundamental molecular biology discoveries
with clinical translation, combining computational design, experimental
validation, and collaborative partnerships to develop next-generation gene
therapies.

## Collaborations — 4 logo cards
**Kicker:** PARTNERS · **Heading:** Institutional Collaborations

| Logo | Name | Caption |
|---|---|---|
| tel-aviv-university.png | Tel Aviv University | Collaborative research in molecular biology, genome editing, and therapeutic development |
| university-of-haifa.png | University of Haifa | Partnership in biochemical engineering and protein structure-function studies |
| rabin-medical-center.png | Rabin Medical Center | Clinical partnership for therapeutic validation and patient-derived cell studies |
| galilee-medical-center.png | Galilee Medical Center | Regional partnership for clinical research and therapeutic implementation |

## Lab Services — 5 cards
**Kicker:** WHAT WE OFFER · **Heading:** Lab Services
**Intro:** Services we provide to academic and industry collaborators.

- 🧫 **Cell Line Models, Engineering & Production** — Design, engineering, and production of custom and stable cell-line models for research and therapeutic use.
- 🧬 **Plasmid Cloning** — Custom molecular cloning and expression-vector construction, from single constructs to complex assemblies.
- 🔬 **CRISPR Libraries** — Design and construction of pooled and arrayed CRISPR guide libraries for screening applications.
- 🧪 **Epigenetic Modifications** — Targeted epigenetic editing to modulate gene expression without altering the underlying DNA sequence.
- 📊 **Molecular Assay Development** — Development and validation of custom molecular assays — reporter systems, qPCR, and functional readouts.

## Join the Lab — 3 cards
**Kicker:** OPPORTUNITIES · **Heading:** Join the Lab
**Intro:** We're looking for curious, rigorous scientists excited about protein
engineering and gene therapy. Open to students, research staff, and collaborators.

- **[Graduate] PhD & MSc Students** — Projects span directed evolution, structural design, and mammalian cell validation of engineered integrases. Background in molecular biology, biochemistry, or bioinformatics welcome.
- **[Staff] Research Assistants** — Hands-on roles in cloning, cell culture, reporter assays, and NGS sample prep. Strong wet-lab fundamentals and attention to detail.
- **[Visiting / Collab] Postdocs & Collaborators** — Interested in PACE, CRISPR-recombinase fusions, or delivery? Reach out to discuss joint projects and funding.

**Button:** Apply / Enquire → mailto:amere@braude.ac.il?subject=Joining the Elias Lab

## Contact *(dark background)*
**Heading:** Ready to Collaborate?
**Text:** Join us in advancing the frontiers of precision genome editing and
transformative gene therapy.

Contact Dr. Amer Elias to discuss research opportunities, clinical partnerships,
or collaborative projects in integrase engineering and therapeutic development.

**Email:** amere@braude.ac.il · **Button:** Get in Touch

## Footer *(dark)*
Braude logo on a **light rounded plate** (the logo is navy — it disappears on dark otherwise), beside:
**Biotechnology Engineering Department**
Braude College of Engineering · Karmiel, Israel

**Elias Lab** — Gene Therapy & Cell Engineering
Engineering site-specific recombinases for precision genome integration and therapeutic innovation
amere@braude.ac.il · © 2026 Elias Lab

---

# Part 4 · The two things Wix can't build

### 1. The att-site scanner
An interactive tool that queries NCBI live. Wix has no equivalent.

**Add → Embed Code → Embed HTML → Code**, then paste the whole of
`wix/scanner-embed.html`. Size the box ~620×480. Place it in the Contact section.

### 2. The Lab Notebook
Needs its own login and database — it stays hosted at
https://amerelias12.github.io/elias-lab/notebook.html

Point the header "Lab Notebook" button at that URL, opening in a new tab.

---

# If Wix AI gives you something you don't like

Rather than fighting it, `wix/elias-lab-wix.html` is the finished site as a
single file. Paste it into one full-width Embed HTML block and it looks exactly
like the local version immediately. The trade-off is weaker SEO, because the
content sits inside an iframe — see `WIX.md`.
