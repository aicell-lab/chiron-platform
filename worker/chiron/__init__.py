"""Chiron platform worker-side components.

Everything in this package runs inside a Chiron worker image and is
model-agnostic: it must not import any foundation model's code. Model images
(chiron-tabula, chiron-scgpt, ...) add the model on top of chiron-base, which
is where this package is installed.
"""
