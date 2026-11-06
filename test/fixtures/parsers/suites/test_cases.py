import pytest


@pytest.mark.case("ARK-T12")
def test_case_only():
    pass


@pytest.mark.ac("CLARA-12-AC1")
def test_ac_only():
    pass


@pytest.mark.ac("CLARA-12-AC2")
@pytest.mark.case("ARK-T13", "ARK-T14")
def test_both():
    pass


def test_neither():
    pass


@pytest.mark.ac("ARK-9/AC1")
def test_slash():
    pass
