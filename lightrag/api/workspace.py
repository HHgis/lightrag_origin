"""Workspace registry and request-scoped resource helpers for the API server."""

from __future__ import annotations

import asyncio
import contextvars
import json
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from lightrag import LightRAG
from lightrag.api.routers.document_routes import DocumentManager
from lightrag.kg.shared_storage import get_namespace_data
from lightrag.utils import logger, validate_workspace

WORKSPACE_REGISTRY_FILENAME = "workspaces.json"

_current_workspace_name: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "lightrag_current_workspace_name",
    default=None,
)


@dataclass(frozen=True)
class WorkspaceEntry:
    name: str
    storage_key: str


class WorkspaceResources:
    """Owns workspace registry, storage-key mapping, and per-workspace resources."""

    def __init__(
        self,
        *,
        working_dir: str | Path,
        input_dir: str | Path,
        default_workspace: str | None,
        create_rag: Callable[[str], LightRAG],
        create_doc_manager: Callable[[str], DocumentManager],
    ) -> None:
        self.working_dir = Path(working_dir)
        self.input_dir = Path(input_dir)
        self.default_workspace = self._normalize_workspace(default_workspace) or "default"
        self._create_rag = create_rag
        self._create_doc_manager = create_doc_manager
        self._lock = asyncio.Lock()
        self._registry_file = self.working_dir / WORKSPACE_REGISTRY_FILENAME
        self._entries_by_name = self._load_registry()
        self._rag_by_storage_key: dict[str, LightRAG] = {}
        self._initialized_storage_keys: set[str] = set()
        self._doc_manager_by_storage_key: dict[str, DocumentManager] = {}

    def _normalize_workspace(self, workspace: str | None) -> str:
        return (workspace or "").strip()

    def _validate_workspace_name(self, workspace: str | None) -> str:
        name = self._normalize_workspace(workspace)
        if not name:
            raise HTTPException(status_code=400, detail="Workspace name is required")
        try:
            validate_workspace(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if len(name) > 64:
            raise HTTPException(
                status_code=400,
                detail="Workspace name must be 64 characters or fewer",
            )
        return name

    def _new_storage_key(self, name: str) -> str:
        try:
            validate_workspace(name)
        except ValueError:
            return f"workspace_{uuid4().hex[:12]}"
        return name

    def _entry_to_json(self, entry: WorkspaceEntry) -> dict[str, str]:
        return {"name": entry.name, "storage_key": entry.storage_key}

    def _load_registry(self) -> dict[str, WorkspaceEntry]:
        default = WorkspaceEntry(
            name=self.default_workspace,
            storage_key=self.default_workspace,
        )
        entries: dict[str, WorkspaceEntry] = {default.name: default}

        if not self._registry_file.exists():
            return entries

        try:
            payload = json.loads(self._registry_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to read workspace registry: %s", exc)
            return entries

        raw_workspaces = payload.get("workspaces", []) if isinstance(payload, dict) else payload
        if not isinstance(raw_workspaces, list):
            return entries

        for raw in raw_workspaces:
            if isinstance(raw, str):
                name = self._normalize_workspace(raw)
                storage_key = name
            elif isinstance(raw, dict):
                name = self._normalize_workspace(raw.get("name"))
                storage_key = self._normalize_workspace(raw.get("storage_key")) or name
            else:
                continue

            if not name or not storage_key:
                continue
            try:
                validate_workspace(name)
                validate_workspace(storage_key)
            except ValueError:
                logger.warning("Skipping invalid workspace registry entry: %s", raw)
                continue
            entries[name] = WorkspaceEntry(name=name, storage_key=storage_key)

        return entries

    def _save_registry(self) -> None:
        self._registry_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "workspaces": [
                self._entry_to_json(entry)
                for entry in sorted(self._entries_by_name.values(), key=lambda item: item.name)
            ]
        }
        self._registry_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def set_request_workspace(self, workspace: str | None) -> contextvars.Token[str | None]:
        name = self.resolve_workspace_name(workspace)
        return _current_workspace_name.set(name)

    def reset_request_workspace(self, token: contextvars.Token[str | None]) -> None:
        _current_workspace_name.reset(token)

    def get_current_workspace_name(self) -> str:
        return _current_workspace_name.get() or self.default_workspace

    def resolve_workspace_name(self, workspace: str | None) -> str:
        name = self._normalize_workspace(workspace) or self.default_workspace
        if name not in self._entries_by_name:
            raise HTTPException(status_code=404, detail=f"Workspace '{name}' does not exist")
        return name

    def resolve_storage_key(self, workspace: str | None) -> str:
        name = self.resolve_workspace_name(workspace)
        return self._entries_by_name[name].storage_key

    def list_workspaces(self) -> list[str]:
        return sorted(self._entries_by_name)

    def list_workspace_entries(self) -> list[WorkspaceEntry]:
        return [
            self._entries_by_name[name]
            for name in sorted(self._entries_by_name)
        ]

    def is_default_workspace(self, workspace: str | None) -> bool:
        return self.resolve_workspace_name(workspace) == self.default_workspace

    async def register_workspace(self, workspace: str | None) -> WorkspaceEntry:
        name = self._validate_workspace_name(workspace)
        async with self._lock:
            if name in self._entries_by_name:
                raise HTTPException(status_code=409, detail=f"Workspace '{name}' already exists")
            storage_key = self._new_storage_key(name)
            existing_storage_keys = {entry.storage_key for entry in self._entries_by_name.values()}
            while storage_key in existing_storage_keys:
                storage_key = f"workspace_{uuid4().hex[:12]}"
            entry = WorkspaceEntry(name=name, storage_key=storage_key)
            self._entries_by_name[name] = entry
            self._save_registry()

        self._ensure_workspace_dirs(entry.storage_key)
        await self.get_rag_by_name(entry.name)
        self.get_doc_manager_by_name(entry.name)
        return entry

    async def rename_workspace(self, current_name: str | None, new_name: str | None) -> WorkspaceEntry:
        old_name = self._validate_workspace_name(current_name)
        next_name = self._validate_workspace_name(new_name)
        if old_name == self.default_workspace:
            raise HTTPException(status_code=400, detail="Default workspace cannot be renamed")
        if old_name == next_name:
            return self._entries_by_name.get(old_name) or WorkspaceEntry(old_name, old_name)

        async with self._lock:
            if old_name not in self._entries_by_name:
                raise HTTPException(status_code=404, detail=f"Workspace '{old_name}' does not exist")
            if next_name in self._entries_by_name:
                raise HTTPException(status_code=409, detail=f"Workspace '{next_name}' already exists")
            old_entry = self._entries_by_name.pop(old_name)
            new_entry = WorkspaceEntry(name=next_name, storage_key=old_entry.storage_key)
            self._entries_by_name[next_name] = new_entry
            self._save_registry()
            return new_entry

    async def delete_workspace(self, workspace: str | None) -> tuple[WorkspaceEntry, list[str]]:
        name = self._validate_workspace_name(workspace)
        if name == self.default_workspace:
            raise HTTPException(status_code=400, detail="Default workspace cannot be deleted")

        async with self._lock:
            entry = self._entries_by_name.get(name)
            if entry is None:
                raise HTTPException(status_code=404, detail=f"Workspace '{name}' does not exist")

        await self._raise_if_pipeline_active(entry.storage_key)
        rag = await self.get_rag_by_name(entry.name)
        doc_manager = self.get_doc_manager_by_name(entry.name)
        drop_targets = [
            rag.text_chunks,
            rag.full_docs,
            rag.full_entities,
            rag.full_relations,
            rag.entity_chunks,
            rag.relation_chunks,
            rag.entities_vdb,
            rag.relationships_vdb,
            rag.chunks_vdb,
            rag.chunk_entity_relation_graph,
            rag.doc_status,
            rag.llm_response_cache,
        ]
        drop_targets = [target for target in drop_targets if target is not None]
        drop_results = await asyncio.gather(
            *(target.drop() for target in drop_targets),
            return_exceptions=True,
        )
        drop_errors = [
            f"{target.__class__.__name__}: {result}"
            for target, result in zip(drop_targets, drop_results)
            if isinstance(result, Exception)
        ]
        if drop_errors:
            raise HTTPException(
                status_code=500,
                detail="Failed to delete workspace storage data: " + "; ".join(drop_errors),
            )

        finalize_errors: list[str] = []
        for target in drop_targets:
            finalize = getattr(target, "finalize", None)
            if finalize is None:
                continue
            try:
                await finalize()
            except Exception as exc:
                finalize_errors.append(f"{target.__class__.__name__}: {exc}")
        if finalize_errors:
            logger.warning(
                "Workspace storage finalize errors for %s: %s",
                entry.storage_key,
                "; ".join(finalize_errors),
            )

        try:
            await rag.finalize_storages()
        except Exception as exc:
            logger.warning("Workspace finalize_storages error for %s: %s", entry.storage_key, exc)

        deleted_directories = self._delete_workspace_dirs(entry.storage_key, doc_manager.input_dir)
        async with self._lock:
            self._rag_by_storage_key.pop(entry.storage_key, None)
            self._initialized_storage_keys.discard(entry.storage_key)
            self._doc_manager_by_storage_key.pop(entry.storage_key, None)
            self._entries_by_name.pop(entry.name, None)
            self._save_registry()

        logger.info("Workspace deleted: %s (%s)", entry.name, entry.storage_key)
        return entry, deleted_directories

    def get_rag_by_storage_key_sync(self, storage_key: str) -> LightRAG:
        rag = self._rag_by_storage_key.get(storage_key)
        if rag is None:
            self._ensure_workspace_dirs(storage_key)
            rag = self._create_rag(storage_key)
            self._rag_by_storage_key[storage_key] = rag
        return rag

    async def get_rag_by_name(self, workspace: str | None) -> LightRAG:
        storage_key = self.resolve_storage_key(workspace)
        async with self._lock:
            rag = self._rag_by_storage_key.get(storage_key)
            if rag is None:
                rag = self.get_rag_by_storage_key_sync(storage_key)
            if storage_key not in self._initialized_storage_keys:
                await rag.initialize_storages()
                await rag.check_and_migrate_data()
                self._initialized_storage_keys.add(storage_key)
            return rag

    def get_current_rag_sync(self) -> LightRAG:
        storage_key = self.resolve_storage_key(self.get_current_workspace_name())
        return self.get_rag_by_storage_key_sync(storage_key)

    def get_doc_manager_by_name(self, workspace: str | None) -> DocumentManager:
        storage_key = self.resolve_storage_key(workspace)
        doc_manager = self._doc_manager_by_storage_key.get(storage_key)
        if doc_manager is None:
            doc_manager = self._create_doc_manager(storage_key)
            self._doc_manager_by_storage_key[storage_key] = doc_manager
        return doc_manager

    def get_current_doc_manager_sync(self) -> DocumentManager:
        return self.get_doc_manager_by_name(self.get_current_workspace_name())

    async def finalize_all(self) -> None:
        for rag in list(self._rag_by_storage_key.values()):
            await rag.finalize_storages()

    def _ensure_workspace_dirs(self, storage_key: str) -> None:
        Path(self.working_dir, storage_key).mkdir(parents=True, exist_ok=True)
        Path(self.input_dir, storage_key).mkdir(parents=True, exist_ok=True)

    def _delete_workspace_dirs(self, storage_key: str, doc_manager_input_dir: Path) -> list[str]:
        directories = [
            Path(self.working_dir, storage_key),
            Path(self.input_dir, storage_key),
            doc_manager_input_dir,
        ]
        deleted: list[str] = []
        seen: set[str] = set()
        for directory in directories:
            key = str(directory)
            if key in seen:
                continue
            seen.add(key)
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=False)
                deleted.append(key)
        return deleted

    async def _raise_if_pipeline_active(self, storage_key: str) -> None:
        pipeline_status = await get_namespace_data("pipeline_status", workspace=storage_key)
        if (
            pipeline_status.get("busy")
            or pipeline_status.get("scanning")
            or pipeline_status.get("destructive_busy")
            or int(pipeline_status.get("pending_enqueues", 0) or 0) > 0
        ):
            raise HTTPException(
                status_code=409,
                detail="Cannot delete workspace while pipeline is active",
            )


class WorkspaceRagProxy:
    def __init__(self, resources: WorkspaceResources) -> None:
        self._resources = resources

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resources.get_current_rag_sync(), name)


class WorkspaceDocManagerProxy:
    def __init__(self, resources: WorkspaceResources) -> None:
        self._resources = resources

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resources.get_current_doc_manager_sync(), name)