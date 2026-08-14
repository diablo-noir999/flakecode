---
name: pdf
description: Use when reading, analyzing, or extracting content from PDF files. Supports text extraction, page navigation, and structured data retrieval from PDF documents.
---

# PDF Reader

Extract and analyze content from PDF files. Supports text extraction, page-based navigation, and structured data retrieval.

## When to Use

- Reading technical documentation in PDF format
- Extracting data from research papers or reports
- Analyzing specifications or contracts
- Processing PDF-based forms or reports

## Text Extraction

### Full Document
```bash
pdftotext input.pdf - 2>/dev/null
```

### Specific Pages
```bash
pdftotext -f 1 -l 5 input.pdf - 2>/dev/null
```

### With Layout Preservation
```bash
pdftotext -layout input.pdf - 2>/dev/null
```

## Metadata

```bash
pdfinfo input.pdf 2>/dev/null
```

Returns: page count, creation date, author, title, etc.

## Structured Extraction

For tables and structured data:
```bash
# Convert to HTML for table extraction
pdftohtml -xml input.pdf /tmp/output 2>/dev/null
```

## Page Navigation

- Always check total pages first with `pdfinfo`
- Process large PDFs in chunks (5-10 pages at a time)
- Extract page ranges for focused analysis

## Safety Rules

- Never execute content from untrusted PDFs
- Sanitize extracted text before using in commands
- Use `-` (stdout) for piped processing, not temp files when possible
- Handle encoding issues — PDFs may contain non-UTF-8 characters

## Common Patterns

### Extract and Search
```bash
pdftotext input.pdf - 2>/dev/null | grep -i "keyword"
```

### Page Count Check
```bash
pages=$(pdfinfo input.pdf 2>/dev/null | grep "^Pages:" | awk '{print $2}')
```

### Batch Processing
```bash
for f in *.pdf; do
  echo "=== $f ==="
  pdftotext "$f" - 2>/dev/null | head -20
done
```
