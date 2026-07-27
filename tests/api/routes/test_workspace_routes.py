import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.offline

_ENV_VARS_TO_ISOLATE = (
    "LLM_BINDING",
    "EMBEDDING_BINDING",
    "LIGHTRAG_API_KEY",
    "LIGHTRAG_WORKSPACE",
    "LIGHTRAG_KV_STORAGE",
    "LIGHTRAG_VECTOR_STORAGE",
    "LIGHTRAG_GRAPH_STORAGE",
    "LIGHTRAG_DOC_STATUS_STORAGE",
)


class _StorageStub:
    def __init__(self) -> None:
        self.drop = AsyncMock()
        self.finalize = AsyncMock()


class _RagStub:
    def __init__(self, *args, **kwargs) -> None:
        self.workspace = kwargs.get("workspace", "default")
        self.ollama_server_infos = SimpleNamespace()
        for attr in (
            "text_chunks",
            "full_docs",
            "full_entities",
            "full_relations",
            "entity_chunks",
            "relation_chunks",
            "entities_vdb",
            "relationships_vdb",
            "chunks_vdb",
            "chunk_entity_relation_graph",
            "doc_status",
            "llm_response_cache",
        ):
            setattr(self, attr, _StorageStub())
        self.initialize_storages = AsyncMock()
        self.check_and_migrate_data = AsyncMock()
        self.finalize_storages = AsyncMock()
        self.get_rerank_queue_status = AsyncMock(return_value={})

    def register_role_llm_builder(self, builder) -> None:
        self.role_llm_builder = builder

    def get_llm_role_config(self) -> dict:
        return {}


def _build_client(monkeypatch, tmp_path: Path) -> TestClient:
    for var in _ENV_VARS_TO_ISOLATE:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LLM_BINDING", "openai")
    monkeypatch.setenv("EMBEDDING_BINDING", "openai")

    original_argv = sys.argv.copy()
    try:
        sys.argv = ["lightrag-server"]
        from lightrag.api.config import parse_args
        import lightrag.api.lightrag_server as server

        args = parse_args()
        args.working_dir = str(tmp_path / "working")
        args.input_dir = str(tmp_path / "input")
        args.workspace = "default"

        monkeypatch.setattr(server, "check_frontend_build", lambda: (False, False))
        monkeypatch.setattr(server, "LightRAG", _RagStub)
        monkeypatch.setattr(
            "lightrag.api.workspace.get_namespace_data",
            AsyncMock(return_value={}),
        )

        return TestClient(server.create_app(args))
    finally:
        sys.argv = original_argv


def test_workspace_routes_create_rename_delete_keep_storage_key(monkeypatch, tmp_path):
    client = _build_client(monkeypatch, tmp_path)

    list_response = client.get("/workspaces")
    assert list_response.status_code == 200, list_response.text
    assert list_response.json() == {
        "workspaces": [
            {"name": "default", "storage_key": "default", "is_default": True}
        ],
        "current_workspace": "default",
        "default_workspace": "default",
    }

    create_response = client.post("/workspaces", json={"name": "demo"})
    assert create_response.status_code == 200, create_response.text
    created = create_response.json()["workspace"]
    assert created == {"name": "demo", "storage_key": "demo", "is_default": False}
    assert (tmp_path / "working" / "demo").is_dir()
    assert (tmp_path / "input" / "demo").is_dir()

    rename_response = client.put("/workspaces/demo", json={"name": "renamed-demo"})
    assert rename_response.status_code == 200, rename_response.text
    renamed_payload = rename_response.json()
    assert renamed_payload["workspace"] == {
        "name": "renamed-demo",
        "storage_key": "demo",
        "is_default": False,
    }
    assert [item["name"] for item in renamed_payload["workspaces"]] == [
        "default",
        "renamed-demo",
    ]

    delete_response = client.delete("/workspaces/renamed-demo")
    assert delete_response.status_code == 200, delete_response.text
    deleted_payload = delete_response.json()
    assert deleted_payload["current_workspace"] == "default"
    assert deleted_payload["workspaces"] == [
        {"name": "default", "storage_key": "default", "is_default": True}
    ]
    assert not (tmp_path / "working" / "demo").exists()
    assert not (tmp_path / "input" / "demo").exists()


def test_workspace_resources_initializes_rag_created_by_sync_proxy(tmp_path):
    from lightrag.api.workspace import WorkspaceRagProxy, WorkspaceResources

    created_rags = []

    def create_rag(storage_key: str):
        rag = _RagStub(workspace=storage_key)
        created_rags.append(rag)
        return rag

    resources = WorkspaceResources(
        working_dir=tmp_path / "working",
        input_dir=tmp_path / "input",
        default_workspace="default",
        create_rag=create_rag,
        create_doc_manager=lambda storage_key: SimpleNamespace(
            input_dir=tmp_path / "input" / storage_key
        ),
    )
    proxy = WorkspaceRagProxy(resources)

    assert proxy.ollama_server_infos is not None
    assert created_rags[0].initialize_storages.await_count == 0

    rag = asyncio.run(resources.get_rag_by_name("default"))

    assert rag is created_rags[0]
    created_rags[0].initialize_storages.assert_awaited_once()
    created_rags[0].check_and_migrate_data.assert_awaited_once()


def test_workspace_routes_reject_invalid_duplicate_and_default_changes(
    monkeypatch, tmp_path
):
    client = _build_client(monkeypatch, tmp_path)

    invalid_response = client.post("/workspaces", json={"name": "../escape"})
    assert invalid_response.status_code == 400

    first_create = client.post("/workspaces", json={"name": "demo"})
    assert first_create.status_code == 200, first_create.text

    duplicate_response = client.post("/workspaces", json={"name": "demo"})
    assert duplicate_response.status_code == 409

    rename_default_response = client.put(
        "/workspaces/default",
        json={"name": "renamed-default"},
    )
    assert rename_default_response.status_code == 400

    delete_default_response = client.delete("/workspaces/default")
    assert delete_default_response.status_code == 400