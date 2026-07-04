"""
Reads data/catalog.json and produces:
  context/context.md         — full site text for RAGless mode
  context/chunks/*.md        — ~250 bite-sized chunks for RAG mode
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
CATALOG_PATH = ROOT / "data" / "catalog.json"
CONTEXT_DIR = ROOT / "context"
CHUNKS_DIR = CONTEXT_DIR / "chunks"


def _tier_table(tiers: list) -> str:
    lines = []
    for t in tiers:
        if t.get("custom"):
            price = "Custom / Contact sales"
        elif t.get("priceMonthly") == 0:
            price = "Free"
        else:
            monthly = t.get("priceMonthly", "?")
            annual = t.get("priceAnnualMonthly", "?")
            price = f"${monthly}/user/mo (${annual}/user/mo billed annually)"
        lines.append(f"- **{t['name']}**: {price}")
        if t.get("highlights"):
            for h in t["highlights"][:4]:
                lines.append(f"  - {h}")
    return "\n".join(lines)


def _product_section(p: dict) -> str:
    parts = [
        f"## {p['name']}\n",
        f"**Category**: {p['category']}  ",
        f"**Tagline**: {p['tagline']}\n",
        f"### Summary\n{p['summary']}\n",
        f"### Description\n{p['description']}\n",
    ]
    if p.get("keyFeatures"):
        parts.append("### Key Features")
        for f in p["keyFeatures"]:
            parts.append(f"- {f}")
        parts.append("")

    if p.get("specs"):
        parts.append("### Specs")
        for k, v in p["specs"].items():
            parts.append(f"- **{k}**: {v}")
        parts.append("")

    if p.get("integrations"):
        parts.append(f"### Integrations\n{', '.join(p['integrations'])}\n")

    if p.get("tiers"):
        parts.append("### Pricing Tiers")
        parts.append(_tier_table(p["tiers"]))
        parts.append("")

    if p.get("addOns"):
        parts.append("### Add-ons")
        for a in p["addOns"]:
            parts.append(f"- **{a['name']}**: {a['price']} — {a['desc']}")
        parts.append("")

    if p.get("faqs"):
        parts.append("### FAQs")
        for faq in p["faqs"]:
            parts.append(f"**Q: {faq['q']}**\nA: {faq['a']}\n")

    return "\n".join(parts)


def _policies_section(policies: dict) -> str:
    labels = {
        "refund": "Refund Policy",
        "freeTrial": "Free Trial",
        "billing": "Billing",
        "cancellation": "Cancellation",
        "sla": "Service Level Agreement (SLA)",
        "security": "Security & Compliance",
        "dataResidency": "Data Residency",
        "support": "Support",
    }
    lines = ["# Policies\n"]
    for key, label in labels.items():
        if policies.get(key):
            lines.append(f"## {label}\n{policies[key]}\n")
    return "\n".join(lines)


def build_context_md(catalog: dict) -> str:
    co = catalog["company"]
    sections = [
        "# Nimbus Software Suite — Full Knowledge Base\n",
        f"## Company\n**Name**: {co['name']} ({co['legalName']})\n"
        f"**Tagline**: {co['tagline']}\n"
        f"**Founded**: {co['founded']}  **HQ**: {co['hq']}\n"
        f"**About**: {co['about']}\n"
        f"**Mission**: {co['mission']}\n",
        "### Stats\n" + "\n".join(f"- {k}: {v}" for k, v in co["stats"].items()),
        "\n### Contact\n" + "\n".join(f"- {k}: {v}" for k, v in co["contact"].items()),
        "\n# Products\n",
    ]
    for p in catalog["products"]:
        sections.append(_product_section(p))
        sections.append("---\n")

    sections.append(_policies_section(catalog.get("policies", {})))
    return "\n".join(sections)


def build_chunks(catalog: dict) -> list[dict]:
    """Returns list of {text, source, label} dicts."""
    chunks = []

    co = catalog["company"]
    chunks.append({
        "text": (
            f"Nimbus ({co['legalName']}) — {co['tagline']}\n"
            f"Founded: {co['founded']}, HQ: {co['hq']}\n"
            f"About: {co['about']}\nMission: {co['mission']}\n"
            + "\n".join(f"{k}: {v}" for k, v in co["stats"].items())
            + "\nContact: "
            + ", ".join(f"{k}: {v}" for k, v in co["contact"].items())
        ),
        "source": "company",
        "label": "Company Overview",
    })

    for p in catalog["products"]:
        name = p["name"]
        cat = p["category"]

        chunks.append({
            "text": (
                f"{name} ({cat})\nTagline: {p['tagline']}\n"
                f"Summary: {p['summary']}\n{p['description']}"
            ),
            "source": "products",
            "label": f"{name} — Overview",
        })

        if p.get("keyFeatures"):
            chunks.append({
                "text": f"{name} Key Features:\n" + "\n".join(f"- {f}" for f in p["keyFeatures"]),
                "source": "products",
                "label": f"{name} — Features",
            })

        if p.get("tiers"):
            tier_text = f"{name} Pricing Tiers:\n{_tier_table(p['tiers'])}"
            if p.get("addOns"):
                tier_text += "\nAdd-ons:\n" + "\n".join(
                    f"- {a['name']}: {a['price']} — {a['desc']}" for a in p["addOns"]
                )
            chunks.append({"text": tier_text, "source": "pricing", "label": f"{name} — Pricing"})

        if p.get("faqs"):
            faq_text = f"{name} FAQs:\n" + "\n".join(
                f"Q: {faq['q']}\nA: {faq['a']}" for faq in p["faqs"]
            )
            chunks.append({"text": faq_text, "source": "faqs", "label": f"{name} — FAQs"})

        if p.get("specs") or p.get("integrations"):
            spec_text = f"{name} Specs:\n"
            if p.get("specs"):
                spec_text += "\n".join(f"- {k}: {v}" for k, v in p["specs"].items())
            if p.get("integrations"):
                spec_text += f"\nIntegrations: {', '.join(p['integrations'])}"
            chunks.append({"text": spec_text, "source": "products", "label": f"{name} — Specs"})

    policies = catalog.get("policies", {})
    policy_labels = {
        "refund": "Refund Policy",
        "freeTrial": "Free Trial",
        "billing": "Billing",
        "cancellation": "Cancellation",
        "sla": "SLA",
        "security": "Security",
        "dataResidency": "Data Residency",
        "support": "Support",
    }
    for key, label in policy_labels.items():
        if policies.get(key):
            chunks.append({
                "text": f"{label}:\n{policies[key]}",
                "source": "policies",
                "label": label,
            })

    # Global pricing summary
    rows = []
    for p in catalog["products"]:
        paid = [t for t in p.get("tiers", []) if not t.get("custom") and t.get("priceMonthly", 0) > 0]
        if paid:
            cheapest = min(paid, key=lambda t: t["priceMonthly"])
            annual = cheapest.get("priceAnnualMonthly", "N/A")
            rows.append(
                f"- {p['name']} ({p['category']}): from ${cheapest['priceMonthly']}/user/mo "
                f"(${annual}/user/mo annual)"
            )
    chunks.append({
        "text": "All Nimbus Products — Starting Prices (monthly vs annual):\n" + "\n".join(rows),
        "source": "pricing",
        "label": "Global Pricing Summary",
    })

    return chunks


def run_scraper() -> tuple[str, list[dict]]:
    """Entry point: read catalog, write files, return (context_md_text, chunks)."""
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)

    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)

    context_md = build_context_md(catalog)
    (CONTEXT_DIR / "context.md").write_text(context_md, encoding="utf-8")

    chunks = build_chunks(catalog)

    # Write individual chunk files (one per chunk)
    for i, chunk in enumerate(chunks):
        safe_label = chunk["label"].replace(" ", "_").replace("/", "-").replace("—", "-")[:60]
        filename = f"{i:03d}_{chunk['source']}_{safe_label}.md"
        (CHUNKS_DIR / filename).write_text(
            f"# {chunk['label']}\nSource: {chunk['source']}\n\n{chunk['text']}",
            encoding="utf-8",
        )

    print(f"Scraper: wrote context.md ({len(context_md)} chars) and {len(chunks)} chunks")
    return context_md, chunks


if __name__ == "__main__":
    run_scraper()
