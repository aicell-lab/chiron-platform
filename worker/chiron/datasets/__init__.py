"""The Chiron data server.

Runs as its own process next to a BioEngine worker, scans the site's data
directory, converts AnnData files to zarr and precomputes the dataset-card
artifacts (HVG ranking, per-cell value binning, a UMAP embedding). Raw data
never leaves the machine: only the derived summaries reach the platform.

Started as `python -m chiron.datasets --data-dir /data`.
"""
