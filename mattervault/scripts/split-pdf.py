#!/usr/bin/env python3
"""Split large PDFs into chunks for Docling processing.

Usage: python3 split-pdf.py input.pdf output_dir/ --max-pages 25

Returns JSON array of chunk files with page offsets:
[{"file": "chunk_001.pdf", "page_offset": 0, "page_count": 25}, ...]

If the PDF has <= max_pages, returns the original file unchanged.
"""
import sys
import os
import json
import argparse


def split_pdf(input_path, output_dir, max_pages=25):
    from PyPDF2 import PdfReader, PdfWriter

    if not os.path.isfile(input_path):
        print(f"Error: file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    try:
        reader = PdfReader(input_path)
    except Exception as e:
        print(f"Error: cannot read PDF: {e}", file=sys.stderr)
        sys.exit(1)

    total = len(reader.pages)
    if total == 0:
        print(f"Error: PDF has no pages: {input_path}", file=sys.stderr)
        sys.exit(1)

    if total <= max_pages:
        print(json.dumps([{"file": input_path, "page_offset": 0, "page_count": total}]))
        return

    os.makedirs(output_dir, exist_ok=True)
    chunks = []
    for start in range(0, total, max_pages):
        end = min(start + max_pages, total)
        writer = PdfWriter()
        for i in range(start, end):
            writer.add_page(reader.pages[i])

        chunk_name = f"chunk_{start // max_pages + 1:03d}.pdf"
        chunk_path = os.path.join(output_dir, chunk_name)
        try:
            with open(chunk_path, "wb") as f:
                writer.write(f)
        except OSError as e:
            print(f"Error: cannot write {chunk_path}: {e}", file=sys.stderr)
            sys.exit(1)

        chunks.append({
            "file": chunk_path,
            "page_offset": start,
            "page_count": end - start
        })

    print(json.dumps(chunks))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Split large PDFs into chunks for Docling processing"
    )
    parser.add_argument("input", help="Input PDF path")
    parser.add_argument("output_dir", help="Output directory for chunks")
    parser.add_argument("--max-pages", type=int, default=25,
                        help="Maximum pages per chunk (default: 25)")
    args = parser.parse_args()
    split_pdf(args.input, args.output_dir, args.max_pages)
