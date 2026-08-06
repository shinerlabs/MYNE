from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.colors import HexColor


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "MYNE-staking-statement.pdf"


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = A4
    pdf = Canvas(str(OUT), pagesize=A4)
    pdf.setTitle("MYNE Staking Statement")
    pdf.setAuthor("MYNE Protocol")
    pdf.setFillColor(HexColor("#08090b"))
    pdf.rect(0, 0, width, height, fill=1, stroke=0)

    # Pearl brand rule.
    colors = ["#fff1ba", "#bde9ff", "#f2c8ff", "#ffffff"]
    segment = (width - 80) / len(colors)
    for index, color in enumerate(colors):
        pdf.setFillColor(HexColor(color))
        pdf.rect(40 + index * segment, height - 42, segment, 2.5, fill=1, stroke=0)

    pdf.setFillColor(HexColor("#f7f7f7"))
    pdf.setFont("Helvetica-Bold", 19)
    pdf.drawString(42, height - 85, "MYNE")
    pdf.setFillColor(HexColor("#8f9299"))
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawRightString(width - 42, height - 82, "STAKING STATEMENT")

    pdf.setFillColor(HexColor("#9a9ca2"))
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(42, height - 160, "CLAIMABLE SOL")
    pdf.setFillColor(HexColor("#ffffff"))
    pdf.setFont("Helvetica-Bold", 45)
    pdf.drawString(42, height - 215, "0.000 SOL")
    pdf.setStrokeColor(HexColor("#282a2f"))
    pdf.line(42, height - 245, width - 42, height - 245)

    rows = [
        ("TOTAL SOL EARNED", "0.000 SOL"),
        ("STANDARD STAKE", "0.00 MYNE"),
        ("BURN STAKE", "0.00 MYNE"),
        ("STAKING WEIGHT", "0.00 MYNE"),
        ("POOL SHARE", "0.0000%"),
    ]
    y = height - 295
    for label, value in rows:
        pdf.setFillColor(HexColor("#85888f"))
        pdf.setFont("Helvetica-Bold", 8)
        pdf.drawString(42, y, label)
        pdf.setFillColor(HexColor("#f5f5f5"))
        pdf.setFont("Helvetica-Bold", 17)
        pdf.drawRightString(width - 42, y - 2, value)
        pdf.setStrokeColor(HexColor("#202227"))
        pdf.line(42, y - 28, width - 42, y - 28)
        y -= 66

    pdf.setFillColor(HexColor("#f0f0f0"))
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawString(42, 145, "7% mining + 3% trading")
    pdf.setFillColor(HexColor("#989ba1"))
    pdf.setFont("Helvetica", 9.5)
    pdf.drawString(42, 126, "Protocol revenue is distributed in SOL by staking weight.")
    pdf.drawString(42, 91, "Wallet  Not connected")
    pdf.drawString(42, 75, "Generated from the MYNE staking dashboard")
    pdf.setFillColor(HexColor("#74777e"))
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(42, 43, "Rewards vary with mining and trading volume. Values reflect the chain at generation time.")
    pdf.setFillColor(HexColor("#a5a8ae"))
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawRightString(width - 42, 75, "SOLANA")
    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    build()
