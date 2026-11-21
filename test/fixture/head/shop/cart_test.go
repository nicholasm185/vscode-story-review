package shop

import "testing"

func TestTotalTakesTheBestCode(t *testing.T) {
	items := []Item{{Name: "lamp", Price: 6000, Qty: 2}}
	if got := Total(items, []string{"save10", "BIG25"}); got != 9000 {
		t.Fatalf("Total = %d, want 9000", got)
	}
}

func TestTotalIgnoresUnknownCodes(t *testing.T) {
	items := []Item{{Name: "pen", Price: 300, Qty: 1}}
	if got := Total(items, []string{"NOPE"}); got != 300 {
		t.Fatalf("Total = %d, want 300", got)
	}
}
