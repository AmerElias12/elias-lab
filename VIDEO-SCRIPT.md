# Lab Notebook — video tutorial script

**Target length:** 4:30–4:45
**Audience:** new lab members on day one
**Tone:** clear, encouraging, efficient. Nobody watching this has a spare hour.

**Production notes**

- Record at **1440 × 900** or larger. The notebook has a fixed sidebar and a
  wide content area; anything narrower crops the plasmid map.
- Sign in as a demo member, **not** as the PI. The PI account shows the User
  Management tab, which is not part of this tutorial and raises questions.
- Seed the demo data first: three plasmids, a handful of primers, two cell
  lines, three glycerol stocks, two kits. An empty notebook films badly.
- Cursor highlighting on. Slow the pointer down — screen capture makes every
  movement look twice as fast as it felt.

---

| # | Visual / screen action | Audio / voiceover |
|---|---|---|
| **1**<br>0:00–0:14 | Cold open on a cluttered bench: a freezer box with handwritten lids, a notebook page, a phone photo of a gel. Quick cuts, slightly chaotic. Snap to the clean notebook Dashboard. | Every lab runs on the same question: *where is it, and what is in it?* Usually the answer is in somebody's head, a spreadsheet, and a box lid. **This is where it lives now.** |
| **2**<br>0:14–0:34 | Slow pan down the sidebar. Hover each group so it lights up: **Overview**, **Research**, **Inventory**, **Admin**. | One sidebar, four groups. **Research** is what you did — protocols, experiments, presentations. **Inventory** is what you have — enzymes, primers, plasmids, stocks, cells, kits. Everything else is built on those two ideas. |
| **3**<br>0:34–0:50 | Click **Dashboard**. Cards count up. Click one card; the breakdown panel expands beneath it. | The Dashboard counts what the lab holds and who added it. Click any card to break it down — a fast way to find out that nobody has logged a miniprep kit since March. |
| **4**<br>0:50–1:12 | Click **Kits & Reagents**. Table fills. Point at the amber banner at the top. Type "spin" in the search box; the table narrows live. | Inventory pages all work the same way. A table, a search box, and three buttons: **add one**, **bulk upload a spreadsheet**, or **export to CSV**. Search filters as you type, across every column. |
| **5**<br>1:12–1:30 | Zoom the expiry banner: "2 expired · 1 expiring within 30 days". Scroll to a row showing a red **expired** pill. | Fill in the expiry date and the page starts working for you — it counts what has expired and what is about to, and flags the row. That banner is the difference between finding out now and finding out mid-experiment. |
| **6**<br>1:30–1:48 | Click **Restriction Enzymes**. Click **+ Add Enzyme**. Fill the form slowly: Name `EcoRI`, Supplier `NEB`, Cut Site `G↓AATTC`, Storage `-20°C Box 2A`. Save; the row appears. | Adding anything is the same form every time. Name it, say where it came from, and — the field people skip — **say where it is stored.** Thirty seconds now, versus ten minutes of opening drawers later. |
| **7**<br>1:48–2:06 | Click **Primers**. The Primer Generator loads. Tab across its three modes: **Cloning**, **qRT-PCR**, **Analytical**. Paste a short sequence; results table appears with Tm and GC. | Primers get a design tool, not just a table. Paste a template and it proposes pairs — for cloning, for qRT-PCR, or for screening genomic DNA — with melting temperatures and GC content worked out. Save the ones you order, and they join the lab's library. |
| **8**<br>2:06–2:30 | Click **Plasmids**, then a plasmid name. The full page opens: circular map left, details right, sequence below. Let the map finish drawing. Click a feature on the ring; the readout beneath names it and its coordinates. | Plasmids get a page of their own. The map is live — click any feature and it tells you what it is and exactly where it sits. The sequence underneath is editable, searchable, and shows your enzyme sites. |
| **9**<br>2:30–2:52 | Click **Enzymes…**. In the dialog, tick `EcoRI` and `BamHI`. The panel below redraws into two fragment maps with coloured feature chips. | This is the part worth slowing down for. Tick two enzymes and the map **splits** — one strip per fragment, each showing what it carries. So "does the insert keep its promoter" is a question you answer by looking, not by counting base pairs. |
| **10**<br>2:52–3:16 | Close. Click **✂ Clone**. Set Vector enzymes. Change Insert source to **A PCR product**, pick a template, then search the primer box — type "GFP"; the list shows which primers anneal. Pick two. Green note: "356 bp product". Pick fragments; result reads "1,358 bp circular". Click **Create the plasmid**. | Cloning is simulated before you touch a pipette. Either side can be a plasmid **or a PCR product** — so a template with no useful site gets one from the primer tails. Search your own primer library; it tells you which ones actually anneal to this template. Every join is checked, and the finished construct is saved as a new plasmid. |
| **11**<br>3:16–3:38 | Click **Tissue Culture**. Click **+ Add Cell Line**. Fill: `HEK293T`, Passage `P12`, Source `ATCC CRL-3216`, Tank `LN2 Tank 1`, Rack `Rack 3`, Box `Box B`, Position `A4`. Save. | Tissue culture is a location log with one extra column that matters: **passage**. Record it when you freeze, not when you thaw. Tank, rack, box, position — four fields that mean somebody else can find your vial without calling you. |
| **12**<br>3:38–4:00 | Click **Glycerol Stocks**. Show the table. Zoom the **Sequenced (QC)** column. Click a **Box** value; the storage box map opens showing filled positions. | Glycerol stocks carry what is in them, where they are at minus eighty, and whether they were ever sequenced. And because the box name is a link, the notebook draws you the box — every occupied position, labelled. |
| **13**<br>4:00–4:22 | Open **Experiment Notebooks → + New Entry**. Type a line. Click **▦ Plate**, choose 24-well, type into two wells. Click **📅 New day**. Then type `@` and pick a plasmid from the popup. Click the chip; its tab opens in the tab bar at the top. | Now tie it together. An entry takes a **plate** you can write into, a **day divider** when an experiment runs over several days, and **@-mentions**. Type the @ sign, pick any plasmid, primer, kit or person, and it becomes a link. Click it, and that item opens in its own tab — because cloning means having four things open at once. |
| **14**<br>4:22–4:45 | Pull back to the Dashboard with four tabs open along the top. Hold. Fade to the lab logo and the notebook URL. | That is the whole notebook: what you have, where it is, and what you did with it — in one place, shared with the lab. The written guide covers every field in detail, and it's linked below. **Welcome aboard.** |

---

## Timing

| Section | Runs | Cumulative |
|---|---|---|
| Hook and orientation (1–3) | 0:50 | 0:50 |
| Inventory (4–6) | 0:58 | 1:48 |
| Primers (7) | 0:18 | 2:06 |
| Plasmids and cloning (8–10) | 1:10 | 3:16 |
| Tissue culture (11) | 0:22 | 3:38 |
| Glycerol stocks (12) | 0:22 | 4:00 |
| Entries, mentions, outro (13–14) | 0:45 | 4:45 |

Plasmids and cloning take a quarter of the runtime because they are a quarter
of the reason the notebook exists. If you need to cut to three minutes, drop
rows **3** and **6** and shorten **13** to the @-mention alone — those are the
three that explain themselves fastest when somebody meets them in the app.

## If you record one thing

Row **10**. Simulating a clone before ordering primers is the capability
nobody expects a lab notebook to have, and it is the one that makes people try
the rest of it.
