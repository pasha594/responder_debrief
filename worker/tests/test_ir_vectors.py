

def test_classify_kmz_layer():
    from responder_worker.ir_vectors import _classify_kmz_layer

    assert _classify_kmz_layer("Intense Heat") == "Intense"
    assert _classify_kmz_layer("Scattered Heat") == "Scattered"
    assert _classify_kmz_layer("Isolated Fires") == "Isolated"
    assert _classify_kmz_layer("Estimated Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Fire Perimeter") == "Perimeter"
    assert _classify_kmz_layer("Cloud Cover") is None
    assert _classify_kmz_layer("Legend 1") is None
    assert _classify_kmz_layer("Layers for Google Earth KMZ") is None
