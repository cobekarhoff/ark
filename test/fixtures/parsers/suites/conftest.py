def pytest_configure(config):
    config.addinivalue_line("markers", "ac(*ids): acceptance criteria this test proves")
    config.addinivalue_line("markers", "case(*ids): test case ids this test implements")

def pytest_runtest_setup(item):
    for marker in item.iter_markers("ac"):
        for criterion in marker.args:
            item.user_properties.append(("ac", criterion))
    for marker in item.iter_markers("case"):
        for case_id in marker.args:
            item.user_properties.append(("case", case_id))
