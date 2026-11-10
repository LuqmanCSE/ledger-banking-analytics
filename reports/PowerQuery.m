// Power BI Desktop: Get Data > Blank Query > Advanced Editor.
// Change BaseUrl to your local or deployed origin. Private hosted Sites require
// browser authentication; for Desktop use local preview or downloaded CSVs.
// This script is an M query, not a PBIX report.
let
    BaseUrl = "http://127.0.0.1:8787",
    Source = Csv.Document(
        Web.Contents(BaseUrl, [RelativePath="api/export", Query=[kind="transactions"]]),
        [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]
    ),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    Typed = Table.TransformColumnTypes(Headers, {
        {"transaction_id", type text}, {"customer_id", type text},
        {"transaction_date", type date}, {"amount", Currency.Type},
        {"transaction_type", type text}, {"branch_id", type text}, {"source", type text}
    })
in
    Typed
