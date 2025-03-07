from typing import List, Optional
from pydantic import BaseModel, Field


class Badge(BaseModel):
    """Badge information for a dataset."""
    label: str
    color: Optional[str] = None
    url: Optional[str] = None


class DatasetManifest(BaseModel):
    """Schema for dataset manifest files."""
    name: str = Field(..., description="Name of the dataset")
    description: str = Field(..., description="Description of the dataset")
    icon: Optional[str] = Field(None, description="Icon URL for the dataset")
    id_emoji: Optional[str] = Field(None, description="Emoji identifier for the dataset")
    tags: Optional[List[str]] = Field(None, description="Tags associated with the dataset")
    badges: Optional[List[Badge]] = Field(None, description="Badges for the dataset")
    covers: Optional[List[str]] = Field(None, description="Cover image URLs")
    type: Optional[str] = Field(None, description="Type of the dataset")
    documentation: Optional[str] = Field(None, description="Documentation URL or content")
    created_at: Optional[str] = Field(None, description="Creation timestamp")
    updated_at: Optional[str] = Field(None, description="Last update timestamp")
    file_count: Optional[int] = Field(None, description="Number of files in the dataset")
    size_bytes: Optional[int] = Field(None, description="Total size of the dataset in bytes")
    owner: Optional[str] = Field(None, description="Owner of the dataset") 