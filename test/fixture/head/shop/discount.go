package shop

import "strings"

// Discount is what one code takes off a cart.
type Discount struct {
	Code    string
	Percent int
	MinCart int
}

var discounts = []Discount{
	{Code: "SAVE10", Percent: 10, MinCart: 0},
	{Code: "BIG25", Percent: 25, MinCart: 10000},
}

// bestDiscount is the largest amount any of the codes takes off sum.
func bestDiscount(sum int, codes []string) int {
	best := 0
	for _, code := range codes {
		d, ok := lookup(code)
		if !ok || sum < d.MinCart {
			continue
		}
		if off := sum * d.Percent / 100; off > best {
			best = off
		}
	}
	return best
}

func lookup(code string) (Discount, bool) {
	for _, d := range discounts {
		if strings.EqualFold(d.Code, code) {
			return d, true
		}
	}
	return Discount{}, false
}
