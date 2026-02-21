"""Pydantic models for EIWYG API."""
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class ColorRange(BaseModel):
    min: Optional[float] = None
    max: Optional[float] = None
    color: str = "#22c55e"


class WidgetConfig(BaseModel):
    label: Optional[str] = None
    units: Optional[str] = None
    precision: Optional[int] = None
    fontSize: Optional[int] = 16
    fontColor: Optional[str] = "#e2e8f0"
    backgroundColor: Optional[str] = None
    colorRanges: Optional[list[ColorRange]] = None
    # Numeric input specific
    step: Optional[float] = 1.0
    min: Optional[float] = None
    max: Optional[float] = None
    # Enum specific
    enumLabels: Optional[list[str]] = None
    # Motor specific
    showStop: Optional[bool] = True
    # LED specific
    onColor: Optional[str] = "#22c55e"
    offColor: Optional[str] = "#64748b"
    # Gauge specific
    minValue: Optional[float] = 0.0
    maxValue: Optional[float] = 100.0
    # Plot specific
    maxPoints: Optional[int] = 500
    timeWindow: Optional[float] = 3600.0  # seconds
    lineColor: Optional[str] = "#3b82f6"
    fillArea: Optional[bool] = False
    yMin: Optional[float] = None
    yMax: Optional[float] = None


class Widget(BaseModel):
    id: str
    type: str
    x: int = 0
    y: int = 0
    w: int = 3
    h: int = 2
    pv: Optional[str] = None
    config: WidgetConfig = WidgetConfig()


class DashboardConfig(BaseModel):
    widgets: list[Widget] = []
    columns: int = 12
    variables: dict[str, str] = {}
    theme: str = "blue-dream"


class DashboardCreate(BaseModel):
    slug: str = Field(..., pattern=r'^[a-z0-9][a-z0-9\-]*[a-z0-9]$', min_length=3, max_length=64)
    title: str = ""
    description: str = ""
    username: str = ""
    pw: str = ""
    config: DashboardConfig = DashboardConfig()


class DashboardResponse(BaseModel):
    slug: str
    title: str
    description: str
    username: str
    pw: str = ""
    config: DashboardConfig
    created_at: str
    updated_at: str


class DashboardListItem(BaseModel):
    slug: str
    title: str
    description: str
    username: str
    created_at: str
    updated_at: str


class ChatRequest(BaseModel):
    message: str
    current_config: Optional[DashboardConfig] = None


class ChatResponse(BaseModel):
    reply: str
    suggested_config: Optional[DashboardConfig] = None
