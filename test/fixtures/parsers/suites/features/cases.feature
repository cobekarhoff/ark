Feature: Cases

  @ARK-T12
  Scenario: Case only
    Given a passing step

  @case:ARK-T15
  Scenario: Case with prefix
    Given a passing step

  @ac:CLARA-12-AC1
  Scenario: Old only
    Given a passing step

  @CLARA-12-AC2 @case:ARK-T13
  Scenario: Both
    Given a passing step

  @smoke
  Scenario: Neither
    Given a passing step

  @ARK-9/AC1
  Scenario: Slash
    Given a passing step
