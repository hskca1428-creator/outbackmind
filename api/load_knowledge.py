import os
import uuid
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from openai import OpenAI

QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

client = OpenAI(api_key=OPENAI_API_KEY)
qdrant = QdrantClient(url=QDRANT_URL)

COLLECTION_NAME = "outback_knowledge"


def parse_knowledge_text(content: str):
    chunks = []
    raw_parts = content.split("[Title]")
    for part in raw_parts:
        part = part.strip()
        if not part:
            continue

        lines = part.splitlines()
        title = lines[0].strip()
        body = "\n".join(line.strip() for line in lines[1:] if line.strip())
        full_text = f"{title}\n{body}"

        chunks.append({
            "title": title,
            "text": full_text,
        })

    return chunks


def load_all_knowledge(folder: str):
    all_chunks = []
    for path in sorted(Path(folder).glob("*.txt")):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()

        file_chunks = parse_knowledge_text(content)

        for chunk in file_chunks:
            chunk["source_file"] = path.name

        all_chunks.extend(file_chunks)

    return all_chunks


def get_embedding(text: str):
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text
    )
    return response.data[0].embedding


def main():
    knowledge_folder = "/app/knowledge"
    chunks = load_all_knowledge(knowledge_folder)

    qdrant.recreate_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=1536, distance=Distance.COSINE),
    )

    points = []
    for chunk in chunks:
        vector = get_embedding(chunk["text"])
        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vector,
                payload={
                    "title": chunk["title"],
                    "text": chunk["text"],
                    "source_file": chunk.get("source_file", ""),
                },
            )
        )

    qdrant.upsert(
        collection_name=COLLECTION_NAME,
        points=points,
    )

    print(f"Loaded {len(points)} knowledge chunks into Qdrant collection '{COLLECTION_NAME}'")


if __name__ == "__main__":
    main()
