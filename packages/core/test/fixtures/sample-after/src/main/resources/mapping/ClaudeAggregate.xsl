<?xml version="1.0" encoding="UTF-8"?>
<!-- Groups the flat converter output into IP and CustomParams blocks and adds a constant Source value.
     In:  <root><ip>…</ip><modified>true</modified></root>
     Out: <IpInfoResponse><IP><Address>…</Address></IP><CustomParams><Modified>…</Modified><Source>…</Source></CustomParams></IpInfoResponse> -->
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:output method="xml" encoding="UTF-8" indent="yes"/>

    <xsl:template match="/root">
        <IpInfoResponse>
            <IP>
                <Address><xsl:value-of select="ip"/></Address>
            </IP>
            <CustomParams>
                <Modified><xsl:value-of select="modified"/></Modified>
                <Source>ClaudeXSLT</Source>
            </CustomParams>
        </IpInfoResponse>
    </xsl:template>
</xsl:stylesheet>
